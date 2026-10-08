import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { crearCliente, sembrar, EMAILS } from "../scripts/seed_e2e.js";
import { iniciarServidor } from "./helpers/servidor.js";

// La siembra E2E completa se ejercita en el pipeline hermético del front (e2e/pipeline.sh). Aquí, lo que se puede probar sin base.
describe("siembra E2E: validaciones y cliente de la API", () => {
    it("exige las contraseñas por entorno (no hay contraseñas por defecto en el repositorio)", async () => {
        const base = { JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x@127.0.0.1:1/x" };
        await assert.rejects(sembrar({ ...base, E2E_OPERATIVO_PASSWORD: "operativo-1234" }, () => {}), /Falta E2E_ADMIN_PASSWORD/);
        await assert.rejects(sembrar({ ...base, E2E_ADMIN_PASSWORD: "admin-1234" }, () => {}), /Falta E2E_OPERATIVO_PASSWORD/);
        await assert.rejects(sembrar({ ...base, E2E_ADMIN_PASSWORD: "corta", E2E_OPERATIVO_PASSWORD: "operativo-1234" }, () => {}), /mínimo 8 caracteres/);
        await assert.rejects(sembrar({ E2E_ADMIN_PASSWORD: "admin-1234", E2E_OPERATIVO_PASSWORD: "operativo-1234", DATABASE_URL: "x" }, () => {}), /Falta JWT_SECRET/);
    });

    it("el cliente lanza con método, ruta, estado y mensaje cuando la API no responde 2xx, sin volcar el cuerpo enviado", async () => {
        const srv = createServer((req, res) => {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Ya existe" }));
        });
        const { server, base } = await iniciarServidor(srv);
        try {
            const api = crearCliente(base, "tok");
            await assert.rejects(api.post("/api/categorias/9", { nombre: "X", password: "SECRETO-DE-PRUEBA" }), (e) => {
                assert.match(e.message, /POST \/api\/categorias\/9 → 409: Ya existe/);
                assert.ok(!e.message.includes("SECRETO-DE-PRUEBA"), "el mensaje no debe incluir el cuerpo enviado");
                return true;
            });
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("el cliente envía el Bearer y devuelve json y cabeceras en caso de éxito", async () => {
        let auth;
        const srv = createServer((req, res) => {
            auth = req.headers.authorization;
            res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "gh_session=abc; HttpOnly" });
            res.end(JSON.stringify({ data: { ok: true } }));
        });
        const { server, base } = await iniciarServidor(srv);
        try {
            const r = await crearCliente(base, "mi-token").get("/x");
            assert.equal(auth, "Bearer mi-token");
            assert.deepEqual(r.json, { data: { ok: true } });
            assert.match(r.headers.get("set-cookie"), /gh_session=abc/);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("los correos de la siembra son de un dominio reservado .test (nunca de un cliente real)", () => {
        for (const e of Object.values(EMAILS)) assert.match(e, /@gastronomyhub\.test$/);
    });
});
