import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Contra la API real: lo que se escribe en el log durante peticiones sensibles no contiene el token de una invitación, la contraseña
// de un login, el correo de una búsqueda ni la cookie/cabecera de autorización. Es la comprobación de punta a punta de utils/redactar.js.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("el log no guarda secretos (API real)", { skip: SKIP }, () => {
    const E = 9922;
    const sufijo = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const CORREO = `dueno-${sufijo}@log-sin-secretos.test`;
    let server, base, pool, usuario, tokenSesion, invitacion;

    before(async () => {
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        const { crearInvitacion } = await import("../../src/modules/auth/invitacion.service.js");
        ({ server, base } = await iniciarServidor(app));
        await limpiar();
        await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, 'Log sin secretos')", [E]);
        usuario = (
            await pool.query(
                `INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,empresa_id)
                 VALUES ('dueno','dueno-log',$1,true,true,$2) RETURNING id`,
                [CORREO, E],
            )
        ).rows[0].id;
        tokenSesion = signToken({ id: usuario, empresa_id: E, tv: 0 });
        invitacion = await crearInvitacion(usuario); // token real, de 43 caracteres
    });

    async function limpiar() {
        await pool.query(
            "DELETE FROM usuario_tokens WHERE usuario_id IN (SELECT id FROM usuarios WHERE empresa_id = $1)",
            [E],
        );
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
    }

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    /** Ejecuta `fn` capturando todo lo que el servidor escribe en el log (consola) y lo devuelve como un solo texto. */
    async function capturar(fn) {
        const salida = [];
        mock.method(console, "log", (l) => salida.push(String(l)));
        mock.method(console, "error", (l) => salida.push(String(l)));
        try {
            await fn();
            await new Promise((r) => setTimeout(r, 80)); // el log se escribe al terminar la respuesta
        } finally {
            mock.restoreAll();
        }
        return salida.join("\n");
    }

    it("consultar una invitación con un token real: la ruta sale como /invitacion/:token", async () => {
        let estado;
        const log = await capturar(async () => {
            const r = await fetch(`${base}/api/auth/invitacion/${invitacion.token}`);
            estado = r.status;
            await r.text();
        });
        assert.equal(estado, 200, "el token de la prueba es válido");
        assert.equal(log.includes(invitacion.token), false, `el token se coló en el log:\n${log}`);
        assert.match(log, /\/api\/auth\/invitacion\/:token/);
    });

    it("un token mal formado o inventado tampoco aparece", async () => {
        const falso = "token-inventado-por-un-atacante-0123456789";
        const log = await capturar(async () => {
            const r = await fetch(`${base}/api/auth/invitacion/${falso}`);
            await r.text();
        });
        assert.equal(log.includes(falso), false, log);
    });

    it("un login fallido: ni la contraseña ni el correo escritos aparecen en el log", async () => {
        const clave = "ClaveQueNoDebeVerseEnElLog-9";
        const log = await capturar(async () => {
            const r = await fetch(`${base}/api/auth/login`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                },
                body: JSON.stringify({ email: CORREO, password: clave }),
            });
            assert.equal(r.status, 401);
            await r.text();
        });
        assert.equal(log.includes(clave), false, log);
        assert.equal(log.includes(CORREO), false, log);
    });

    it("una búsqueda con un correo en la query: se registra el nombre del parámetro, no su valor", async () => {
        const log = await capturar(async () => {
            const r = await fetch(`${base}/api/usuarios/${E}?q=${encodeURIComponent(CORREO)}`, {
                headers: { Authorization: `Bearer ${tokenSesion}` },
            });
            await r.text();
        });
        assert.equal(log.includes(CORREO), false, log);
        assert.equal(log.includes(encodeURIComponent(CORREO)), false, log);
        assert.match(log, /"query_keys":\["q"\]/);
    });

    it("la sesión (JWT) y la cabecera de autorización nunca salen en ninguna línea", async () => {
        const log = await capturar(async () => {
            const r = await fetch(`${base}/api/productos/${E}`, {
                headers: {
                    Authorization: `Bearer ${tokenSesion}`,
                    Cookie: `gh_session=${tokenSesion}`,
                },
            });
            await r.text();
        });
        assert.equal(log.includes(tokenSesion), false, log);
        assert.equal(log.toLowerCase().includes("bearer "), false, log);
    });
});
