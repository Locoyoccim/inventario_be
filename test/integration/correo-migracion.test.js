import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crearPoolMigrador } from "../helpers/migrador.js";
import { tomarExclusivo } from "../helpers/exclusion.js";
import { auditarCorreos } from "../../scripts/audit_correos.js";

// AUD-003, migración 053 y su auditoría: si dos cuentas chocarían al normalizar, la migración se detiene SIN decidir por nadie y sin
// imprimir correos; si no hay choque, normaliza y deja la restricción. Todo dentro de una transacción que se deshace.
// Se quita la restricción un momento (DDL global): por eso el candado exclusivo (test/helpers/exclusion.js).

const DB = process.env.TEST_MIGRATOR_URL;
const SKIP = !DB && "define TEST_MIGRATOR_URL para correrlo";

const SQL = readFileSync("db/migrations/053_correo_normalizado.sql", "utf8");
// El archivo trae su propio BEGIN/COMMIT; aquí corre dentro de la transacción de la prueba.
const CUERPO = SQL.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

describe("Migración 053 — correo normalizado (AUD-003)", { skip: SKIP }, () => {
    const E1 = 9621;
    const E2 = 9622;
    let pool, candado, c;

    before(async () => {
        candado = await tomarExclusivo();
        pool = crearPoolMigrador();
        c = await pool.connect();
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '20s'");
        await c.query("ALTER TABLE usuarios DROP CONSTRAINT usuarios_email_normalizado_chk");
        await c.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Mig A'),($2,'Mig B')", [
            E1,
            E2,
        ]);
        const alta = (empresa, codigo, email) =>
            c.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,email,empresa_id) VALUES ('P',$1,$2,$3)",
                [codigo, email, empresa],
            );
        await alta(E1, "CM-1", "Dup@Migracion.test");
        await alta(E2, "CM-2", "dup@migracion.test ");
        await alta(E1, "CM-3", " Solo@Migracion.Test ");
        await alta(E1, "CM-4", "");
    });

    after(async () => {
        try {
            await c?.query("ROLLBACK");
        } finally {
            c?.release();
            await pool?.end();
            await candado?.liberar();
        }
    });

    it("la auditoría ve el choque y los correos sin normalizar, sin mostrar correos", async () => {
        const r = await auditarCorreos(c);
        const mio = r.duplicados.find((d) => d.empresas.includes(E1) && d.empresas.includes(E2));
        assert.ok(mio, "el choque aparece");
        assert.equal(mio.usuarios.length, 2);
        assert.equal(r.sin_normalizar, 4);
        assert.ok(!JSON.stringify(r).includes("migracion.test"), "solo ids y empresas");
    });

    it("con un choque, la migración se detiene y dice cuáles cuentas (ids), sin correos", async () => {
        await c.query("SAVEPOINT s");
        await assert.rejects(c.query(CUERPO), (e) => {
            assert.match(e.message, /Correos duplicados al normalizar/);
            assert.match(e.message, new RegExp(`empresas ${E1}, ${E2}`));
            assert.ok(!/migracion\.test/i.test(e.message), "no imprime el correo");
            return true;
        });
        await c.query("ROLLBACK TO SAVEPOINT s");
        const intactos = await c.query(
            "SELECT email FROM usuarios WHERE empresa_id = ANY($1) ORDER BY codigo_ingreso",
            [[E1, E2]],
        );
        assert.deepEqual(
            intactos.rows.map((x) => x.email),
            ["Dup@Migracion.test", "dup@migracion.test ", " Solo@Migracion.Test ", ""],
        );
    });

    it("sin choque normaliza (vacío → NULL) y deja la restricción puesta", async () => {
        await c.query("DELETE FROM usuarios WHERE empresa_id = $1", [E2]);
        await c.query(CUERPO);
        const r = await c.query(
            "SELECT codigo_ingreso, email FROM usuarios WHERE empresa_id = $1 ORDER BY codigo_ingreso",
            [E1],
        );
        assert.deepEqual(r.rows, [
            { codigo_ingreso: "CM-1", email: "dup@migracion.test" },
            { codigo_ingreso: "CM-3", email: "solo@migracion.test" },
            { codigo_ingreso: "CM-4", email: null },
        ]);
        assert.deepEqual((await auditarCorreos(c)).sin_normalizar, 0);
        await c.query("SAVEPOINT r");
        await assert.rejects(
            c.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,email,empresa_id) VALUES ('P','CM-5','MAL@x.test',$1)",
                [E1],
            ),
            (e) => e.code === "23514",
        );
        await c.query("ROLLBACK TO SAVEPOINT r");
    });
});
