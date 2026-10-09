import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { evaluarEnv, saltosDeProxy } from "../src/config/env.js";
import { iniciarServidor } from "./helpers/servidor.js";

// Con Railway → Caddy (front) → API hay DOS proxies delante de la API. Si `trust proxy` se queda en 1, req.ip es la IP del proxy del
// front y el límite por IP, los eventos de seguridad y la IP de la bitácora (AUD-011) registran la IP equivocada. Sin base de datos.

describe("TRUST_PROXY_HOPS", () => {
    it("por defecto 1; acepta 0 a 5; cualquier otra cosa cae a 1", () => {
        assert.equal(saltosDeProxy({}), 1);
        for (const n of [0, 1, 2, 5])
            assert.equal(saltosDeProxy({ TRUST_PROXY_HOPS: String(n) }), n);
        for (const malo of ["", "6", "-1", "dos", "2 ", "1.5"])
            assert.equal(saltosDeProxy({ TRUST_PROXY_HOPS: malo }), 1, `«${malo}»`);
    });

    it("el arranque en producción rechaza un valor inválido", () => {
        const base = {
            NODE_ENV: "development",
            DATABASE_URL: "postgres://x@h/db",
            JWT_SECRET: "a".repeat(40),
        };
        assert.deepEqual(evaluarEnv({ ...base, TRUST_PROXY_HOPS: "2" }), []);
        assert.ok(
            evaluarEnv({ ...base, TRUST_PROXY_HOPS: "9" }).some((m) => /TRUST_PROXY_HOPS/.test(m)),
        );
    });

    it("la app real lo usa (no queda un número fijo)", () => {
        const app = readFileSync("src/app.js", "utf8");
        assert.match(app, /app\.set\("trust proxy", saltosDeProxy\(\)\)/);
        assert.doesNotMatch(app, /app\.set\("trust proxy", \d/);
    });

    it("con 2 saltos req.ip es el cliente real; con 1 sería el proxy del front (el error que se evita)", async () => {
        const ipVista = async (hops) => {
            const app = express();
            app.set("trust proxy", saltosDeProxy({ TRUST_PROXY_HOPS: hops }));
            app.get("/ip", (req, res) => res.json({ ip: req.ip }));
            const { server, base } = await iniciarServidor(app);
            try {
                // Cadena real: el cliente 203.0.113.9 llega a Railway; Railway reenvía a Caddy; Caddy anota la IP de Railway (198.51.100.7).
                const r = await fetch(`${base}/ip`, {
                    headers: { "X-Forwarded-For": "203.0.113.9, 198.51.100.7" },
                });
                return (await r.json()).ip;
            } finally {
                await new Promise((res) => server.close(res));
            }
        };
        assert.equal(await ipVista("2"), "203.0.113.9");
        assert.equal(await ipVista(undefined), "198.51.100.7");
    });
});
