import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// /health/ready en la app real: la base «cae» (se hace fallar la consulta), el monitor insiste varias veces y la base vuelve.
// Solo deben quedar tres líneas en el log —cayó, sigue caída (si pasan 5 min) y se recuperó—, no una por consulta.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("readiness en la app real", { skip: SKIP }, () => {
    let server, base, pool;

    before(async () => {
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ server, base } = await iniciarServidor(app));
    });

    after(async () => {
        mock.restoreAll();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    async function consultar(n = 1) {
        const lineas = [];
        const f = (l) => {
            try {
                lineas.push(JSON.parse(l));
            } catch {
                /* no es una línea de log */
            }
        };
        mock.method(console, "log", f);
        mock.method(console, "error", f);
        const estados = [];
        try {
            for (let i = 0; i < n; i++) {
                const r = await fetch(`${base}/health/ready`);
                estados.push(r.status);
                await r.text();
            }
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            mock.restoreAll();
        }
        return { estados, lineas };
    }

    it("sana → caída → sana: una línea al caer, ninguna mientras sigue caída, una al recuperarse; sin líneas de petición", async () => {
        const sana = await consultar(3);
        assert.deepEqual(sana.estados, [200, 200, 200]);
        assert.equal(sana.lineas.length, 0, "con la base bien no se escribe nada");

        const original = pool.query.bind(pool);
        mock.method(pool, "query", async (sql, ...resto) => {
            if (sql === "SELECT 1") throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
            return original(sql, ...resto);
        });
        const caida = await consultar(5);
        mock.restoreAll();
        assert.deepEqual(caida.estados, [503, 503, 503, 503, 503]);
        assert.deepEqual(
            caida.lineas.map((l) => l.message),
            ["readiness_caida"],
            "una sola línea para cinco consultas fallidas",
        );
        assert.equal(caida.lineas[0].level, "error");
        assert.match(caida.lineas[0].error, /ECONNREFUSED/);

        const vuelve = await consultar(3);
        assert.deepEqual(vuelve.estados, [200, 200, 200]);
        assert.deepEqual(
            vuelve.lineas.map((l) => l.message),
            ["readiness_recuperada"],
        );
        assert.equal(vuelve.lineas[0].fallos_consecutivos, 5);
        assert.ok(vuelve.lineas[0].caida_ms >= 0);
    });

    it("la respuesta 503 no revela el motivo", async () => {
        mock.method(pool, "query", async () => {
            throw new Error("password authentication failed for user gh_app");
        });
        let cuerpo;
        try {
            const r = await fetch(`${base}/health/ready`);
            assert.equal(r.status, 503);
            cuerpo = await r.text();
        } finally {
            mock.restoreAll();
        }
        assert.equal(cuerpo, JSON.stringify({ status: "unavailable" }));
        await consultar(1); // deja el vigilante en «listo» para quien siga
    });
});
