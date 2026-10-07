import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { crearPoolMigrador } from "../helpers/migrador.js";
import { evaluarRolDeAplicacion, SQL_ROL_ACTUAL } from "../../src/config/rolDb.js";

// ADR-006 / VCA-015: la suite corre con el rol de la APP (TEST_DATABASE_URL), de privilegios mínimos, y las migraciones/DDL con el
// MIGRADOR (TEST_MIGRATOR_URL). Estas pruebas fijan esa separación: si alguien apunta TEST_DATABASE_URL a un superusuario, fallan.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración BD — la app corre con privilegios mínimos y las migraciones con el migrador", { skip: SKIP }, () => {
    const SONDA = "x_rol_sonda";
    let pool, migrador, app, dueno;

    // Ejecuta una sentencia como la app dentro de una transacción que SIEMPRE se revierte; devuelve el error (o null si se permitió).
    const intentar = async (sql) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            await c.query(sql);
            return null;
        } catch (e) {
            return e;
        } finally {
            await c.query("ROLLBACK").catch(() => {});
            c.release();
        }
    };

    before(async () => {
        ({ default: pool } = await import("../../src/config/db.js"));
        migrador = crearPoolMigrador();
        app = (await pool.query("SELECT current_user AS u")).rows[0].u;
        dueno = (await migrador.query("SELECT current_user AS u")).rows[0].u;
        await migrador.query(`DROP TABLE IF EXISTS ${SONDA}`);
        await migrador.query(`CREATE TABLE ${SONDA} (id serial PRIMARY KEY, nota text)`); // lo crea el migrador, como una migración nueva
    });

    after(async () => {
        try { await migrador.query(`DROP TABLE IF EXISTS ${SONDA}`); } finally {
            await migrador.end();
            await pool.end();
        }
    });

    it("la app y el migrador son roles distintos y ninguno es superusuario", async () => {
        assert.notEqual(app, dueno, "TEST_DATABASE_URL y TEST_MIGRATOR_URL deben ser roles distintos");
        for (const [nombre, db] of [["app", pool], ["migrador", migrador]]) {
            const r = (await db.query("SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
            assert.deepEqual(r, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }, `el rol ${nombre} tiene privilegios de más`);
        }
    });

    it("la consulta de la guardia de arranque, contra la base real, da «ok» para la app (y «error» para el dueño de las tablas)", async () => {
        const info = (await pool.query(SQL_ROL_ACTUAL)).rows[0];
        assert.equal(info.usuario, app);
        assert.equal(info.tablas_propias, 0, "la app no debe ser dueña de ninguna tabla");
        assert.equal(evaluarRolDeAplicacion(info, { NODE_ENV: "production" }).nivel, "ok");
        const infoDueno = (await migrador.query(SQL_ROL_ACTUAL)).rows[0];
        assert.ok(infoDueno.tablas_propias > 0);
        assert.equal(evaluarRolDeAplicacion(infoDueno, { NODE_ENV: "production" }).nivel, "error", "un dueño de tablas no debe pasar la guardia en producción");
    });

    it("la app NO puede hacer DDL, TRUNCATE, ejecutar comandos del servidor, leer sus archivos ni apagar triggers", async () => {
        const prohibidas = [
            ["DROP TABLE", `DROP TABLE ${SONDA}`],
            ["TRUNCATE", `TRUNCATE ${SONDA}`],
            ["ALTER TABLE", `ALTER TABLE ${SONDA} ADD COLUMN x int`],
            ["DISABLE TRIGGER", `ALTER TABLE ${SONDA} DISABLE TRIGGER ALL`],
            ["CREATE TABLE en public", "CREATE TABLE x_rol_no_deberia (i int)"],
            ["CREATE ROLE", "CREATE ROLE x_rol_no_deberia"],
            ["COPY ... TO PROGRAM", "COPY (SELECT 1) TO PROGRAM 'true'"],
            ["pg_read_file", "SELECT pg_read_file('/etc/hosts', 0, 10)"],
            ["leer hashes de roles", "SELECT rolpassword FROM pg_authid LIMIT 1"],
            ["apagar triggers de la sesión", "SET LOCAL session_replication_role = replica"],
        ];
        for (const [nombre, sql] of prohibidas) {
            const e = await intentar(sql);
            assert.ok(e, `«${nombre}» se PERMITIÓ: la suite no está corriendo con privilegios mínimos (¿TEST_DATABASE_URL es un superusuario o el dueño?)`);
            assert.equal(e.code, "42501", `«${nombre}» falló, pero no por privilegios (${e.code}: ${e.message})`);
        }
    });

    it("la app SÍ puede leer y escribir datos (y usar secuencias) en una tabla nueva creada por el migrador: los permisos por defecto funcionan", async () => {
        const privilegios = (await pool.query(
            `SELECT has_table_privilege(current_user, $1, 'SELECT') s, has_table_privilege(current_user, $1, 'INSERT') i,
                    has_table_privilege(current_user, $1, 'UPDATE') u, has_table_privilege(current_user, $1, 'DELETE') d,
                    has_table_privilege(current_user, $1, 'TRUNCATE') t, has_table_privilege(current_user, $1, 'REFERENCES') r,
                    has_table_privilege(current_user, $1, 'TRIGGER') g`, [SONDA])).rows[0];
        assert.deepEqual(privilegios, { s: true, i: true, u: true, d: true, t: false, r: false, g: false });
        const ins = await pool.query(`INSERT INTO ${SONDA} (nota) VALUES ('hola') RETURNING id`); // exige USAGE sobre la secuencia serial
        assert.ok(ins.rows[0].id > 0);
        assert.equal((await pool.query(`UPDATE ${SONDA} SET nota = 'adios' WHERE id = $1`, [ins.rows[0].id])).rowCount, 1);
        assert.equal((await pool.query(`DELETE FROM ${SONDA} WHERE id = $1`, [ins.rows[0].id])).rowCount, 1);
    });

    it("deriva: TODAS las tablas de public son del migrador y la app tiene lectura/escritura en cada una (una migración futura que lo rompa falla aquí)", async () => {
        const ajenas = (await migrador.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m') AND pg_get_userbyid(c.relowner) <> current_user ORDER BY 1`)).rows.map((r) => r.relname);
        assert.deepEqual(ajenas, [], `objetos que no son del migrador «${dueno}»: ${ajenas.join(", ")}. Corre npm run db:roles -- --adoptar`);
        const sinPermiso = (await migrador.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
               AND NOT (has_table_privilege($1, c.oid, 'SELECT') AND has_table_privilege($1, c.oid, 'INSERT')
                        AND has_table_privilege($1, c.oid, 'UPDATE') AND has_table_privilege($1, c.oid, 'DELETE')) ORDER BY 1`, [app])).rows.map((r) => r.relname);
        assert.deepEqual(sinPermiso, [], `tablas sin permisos completos para la app: ${sinPermiso.join(", ")}`);
        const sinSecuencia = (await migrador.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT (has_sequence_privilege($1, c.oid, 'USAGE') AND has_sequence_privilege($1, c.oid, 'SELECT')) ORDER BY 1`, [app])).rows.map((r) => r.relname);
        assert.deepEqual(sinSecuencia, [], `secuencias sin permisos para la app: ${sinSecuencia.join(", ")}`);
    });

    describe("npm run migrate usa el rol migrador", () => {
        const migrate = resolve("db/migrate.js");
        // cwd vacío: dotenv no encuentra el .env real (que apunta a la base de desarrollo).
        const correr = (env) => {
            const dir = mkdtempSync(resolve(tmpdir(), "migrate-"));
            try {
                return spawnSync(process.execPath, [migrate, "status"], { cwd: dir, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, ...env } });
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        };

        it("con MIGRATE_DATABASE_URL (migrador) funciona aunque DATABASE_URL sea la app: la prefiere", () => {
            const r = correr({ DATABASE_URL: DB, MIGRATE_DATABASE_URL: process.env.TEST_MIGRATOR_URL });
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /\[x\] 050_una_caja_por_empresa\.sql/);
        });

        it("solo con el rol de la app falla por permisos y da la pista de MIGRATE_DATABASE_URL", () => {
            const r = correr({ DATABASE_URL: DB });
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stderr, /permission denied|must be owner/i);
            assert.match(r.stderr, /Define MIGRATE_DATABASE_URL/);
        });
    });
});
