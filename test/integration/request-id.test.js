import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// X-Request-Id y contexto del log de petición contra la API real: el id viaja en la respuesta (y CORS lo deja leer al front),
// y una petición autenticada deja en el log quién fue (usuario y empresa activa) y desde dónde (IP).

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("X-Request-Id y log de petición (API real)", { skip: SKIP }, () => {
    const E = 9921;
    const sufijo = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    let server, base, pool, usuario, token;

    before(async () => {
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        ({ server, base } = await iniciarServidor(app));
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
        await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, 'Request Id')", [E]);
        usuario = (
            await pool.query(
                `INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,empresa_id)
                 VALUES ('rid','rid',$1,true,true,$2) RETURNING id`,
                [`rid-${sufijo}@request-id.test`, E],
            )
        ).rows[0].id;
        token = signToken({ id: usuario, empresa_id: E, tv: 0 });
    });

    after(async () => {
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    /** Hace una petición y devuelve la respuesta junto con las líneas de log que salieron mientras tanto. */
    async function conLog(ruta, { cabeceras = {} } = {}) {
        const lineas = [];
        const captura = (l) => {
            try {
                lineas.push(JSON.parse(l));
            } catch {
                /* línea que no es de log JSON */
            }
        };
        mock.method(console, "log", captura);
        mock.method(console, "error", captura);
        try {
            const res = await fetch(base + ruta, { headers: cabeceras });
            await res.text();
            // El log se escribe al terminar la respuesta, un instante después de que el cliente la recibe.
            await new Promise((r) => setTimeout(r, 50));
            return { res, lineas };
        } finally {
            mock.restoreAll();
        }
    }

    it("devuelve el id del cliente si es válido, y uno nuevo si no", async () => {
        const propio = await conLog("/health", {
            cabeceras: { "X-Request-Id": "cliente-abc-12345" },
        });
        assert.equal(propio.res.headers.get("x-request-id"), "cliente-abc-12345");
        const nuevo = await conLog("/health");
        assert.match(nuevo.res.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
        const falso = await conLog("/health", { cabeceras: { "X-Request-Id": "x y" } });
        assert.match(falso.res.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    });

    it("CORS deja que el navegador lea X-Request-Id", async () => {
        const { res } = await conLog("/health", { cabeceras: { Origin: "http://localhost:5173" } });
        assert.match(res.headers.get("access-control-expose-headers") ?? "", /x-request-id/i);
    });

    it("una petición autenticada deja en el log usuario, empresa activa, IP y el mismo id de la cabecera", async () => {
        const { res, lineas } = await conLog(`/api/productos/${E}`, {
            cabeceras: { Authorization: `Bearer ${token}`, "X-Request-Id": "trazable-9921-abc" },
        });
        assert.equal(res.status, 200);
        const l = lineas.find(
            (x) => x.message === "request" && x.requestId === "trazable-9921-abc",
        );
        assert.ok(l, "debe haber una línea de log con ese id");
        assert.equal(l.usuario_id, usuario);
        assert.equal(l.empresa_id, E);
        assert.ok(l.ip, "lleva la IP");
        assert.equal(l.level, "info");
    });

    it("sin sesión (401) la línea sale como warn y sin usuario", async () => {
        const { res, lineas } = await conLog(`/api/productos/${E}`, {
            cabeceras: { "X-Request-Id": "sin-sesion-12345" },
        });
        assert.equal(res.status, 401);
        const l = lineas.find((x) => x.requestId === "sin-sesion-12345");
        assert.equal(l.level, "warn");
        assert.equal(l.usuario_id, null);
    });

    it("las comprobaciones de salud correctas no llenan el log", async () => {
        const { lineas } = await conLog("/health/ready");
        assert.equal(lineas.filter((x) => x.message === "request").length, 0);
    });
});
