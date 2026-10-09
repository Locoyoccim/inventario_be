import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import { BootstrapError, crearMaestro, leerEntrada } from "../../scripts/bootstrap_plataforma.js";

// El primer maestro de plataforma en una base vacía (sin esto, un despliegue nuevo no tiene quién cree las empresas de los clientes).

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("leerEntrada", () => {
    const ok = {
        BOOTSTRAP_EMAIL: "  Dueno@Ejemplo.MX ",
        BOOTSTRAP_PASSWORD: "una-clave-temporal-larga",
    };

    it("normaliza el correo y pone valores por defecto", () => {
        const e = leerEntrada(ok);
        assert.equal(e.email, "dueno@ejemplo.mx");
        assert.equal(e.nombre, "Administrador de plataforma");
        assert.equal(e.empresa, "Plataforma");
    });

    it("rechaza correo inválido o contraseña corta, sin repetir la contraseña en el mensaje", () => {
        assert.throws(
            () => leerEntrada({ ...ok, BOOTSTRAP_EMAIL: "no-es-correo" }),
            /BOOTSTRAP_EMAIL/,
        );
        assert.throws(() => leerEntrada({ ...ok, BOOTSTRAP_EMAIL: undefined }), /BOOTSTRAP_EMAIL/);
        try {
            leerEntrada({ ...ok, BOOTSTRAP_PASSWORD: "corta-123" });
            assert.fail("debió lanzar");
        } catch (e) {
            assert.ok(e instanceof BootstrapError);
            assert.equal(e.codigo, 2);
            assert.ok(!e.message.includes("corta-123"));
        }
    });
});

describe("crearMaestro — contra la base real", { skip: SKIP }, () => {
    const sufijo = `${Date.now().toString(36)}${process.pid}`;
    const correo = (p) => `${p}-${sufijo}@bootstrap.test`;
    const CLAVE = "una-clave-temporal-larga";
    const creados = { usuarios: [], empresas: [] };
    let server, base, pool;

    const entrada = (p) =>
        leerEntrada({
            BOOTSTRAP_EMAIL: correo(p),
            BOOTSTRAP_PASSWORD: CLAVE,
            BOOTSTRAP_EMPRESA: `Plataforma ${sufijo}`,
        });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
    });
    after(async () => {
        try {
            await pool.query("DELETE FROM usuarios WHERE id = ANY($1) OR email LIKE $2", [
                creados.usuarios,
                `%-${sufijo}@bootstrap.test`,
            ]);
            await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [creados.empresas]);
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("crea la empresa y el maestro: contraseña temporal con hash, debe cambiarla, y puede iniciar sesión", async () => {
        const r = await crearMaestro(pool, entrada("a"), { permitirOtro: true });
        assert.equal(r.creado, true);
        creados.usuarios.push(r.usuario_id);
        creados.empresas.push(r.empresa_id);
        const u = (await pool.query("SELECT * FROM usuarios WHERE id = $1", [r.usuario_id]))
            .rows[0];
        assert.equal(u.email, correo("a"));
        assert.deepEqual(
            [
                u.is_platform_admin,
                u.is_owner,
                u.is_admin,
                u.must_change_password,
                u.empresa_id,
                u.role_id,
            ],
            [true, true, true, true, r.empresa_id, 1],
        );
        assert.match(u.password_hash, /^\$2[aby]\$12\$/, "bcrypt, nunca la contraseña");
        assert.ok(!JSON.stringify(u).includes(CLAVE));

        const login = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: correo("a"), password: CLAVE }),
        });
        assert.equal(login.status, 200);
        const j = await login.json();
        assert.equal(j.data.user.is_platform_admin, true);
        assert.equal(j.data.user.must_change_password, true);
    });

    it("es idempotente: repetirlo con el mismo correo no crea nada más", async () => {
        const antes = (
            await pool.query("SELECT count(*)::int n FROM usuarios WHERE email = $1", [correo("a")])
        ).rows[0].n;
        const empresasAntes = (
            await pool.query("SELECT count(*)::int n FROM empresas WHERE nombre = $1", [
                `Plataforma ${sufijo}`,
            ])
        ).rows[0].n;
        const r = await crearMaestro(pool, entrada("a"));
        assert.deepEqual(r, { creado: false, motivo: "ya_es_maestro" });
        assert.equal(
            (
                await pool.query("SELECT count(*)::int n FROM usuarios WHERE email = $1", [
                    correo("a"),
                ])
            ).rows[0].n,
            antes,
        );
        assert.equal(
            (
                await pool.query("SELECT count(*)::int n FROM empresas WHERE nombre = $1", [
                    `Plataforma ${sufijo}`,
                ])
            ).rows[0].n,
            empresasAntes,
        );
    });

    it("con un maestro ya creado, otro correo se detiene (código 1) y no deja nada a medias; --otro lo permite", async () => {
        await assert.rejects(
            crearMaestro(pool, entrada("b")),
            (e) => e instanceof BootstrapError && e.codigo === 1 && /--otro/.test(e.message),
        );
        assert.equal(
            (
                await pool.query("SELECT count(*)::int n FROM usuarios WHERE email = $1", [
                    correo("b"),
                ])
            ).rows[0].n,
            0,
        );
        const sinEmpresa = (
            await pool.query("SELECT count(*)::int n FROM empresas WHERE nombre = $1", [
                `Plataforma ${sufijo}`,
            ])
        ).rows[0].n;
        assert.equal(sinEmpresa, 1, "solo la empresa del primer maestro");
        const r = await crearMaestro(pool, entrada("b"), { permitirOtro: true });
        assert.equal(r.creado, true);
        creados.usuarios.push(r.usuario_id);
        creados.empresas.push(r.empresa_id);
    });

    it("un correo que ya es de un usuario común no se convierte en maestro desde aquí", async () => {
        const emp = (
            await pool.query("INSERT INTO empresas (nombre) VALUES ($1) RETURNING id", [
                `Común ${sufijo}`,
            ])
        ).rows[0].id;
        creados.empresas.push(emp);
        const id = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,email,empresa_id) VALUES ('Común','BS-c',$1,$2) RETURNING id",
                [correo("c"), emp],
            )
        ).rows[0].id;
        creados.usuarios.push(id);
        await assert.rejects(
            crearMaestro(pool, entrada("c"), { permitirOtro: true }),
            (e) => e instanceof BootstrapError && e.codigo === 1,
        );
        assert.equal(
            (await pool.query("SELECT is_platform_admin FROM usuarios WHERE id = $1", [id])).rows[0]
                .is_platform_admin,
            false,
        );
    });
});
