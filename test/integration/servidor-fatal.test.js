import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

// El server.js REAL (no un doble): arranca contra la base de pruebas y se le provoca un error que nadie captura. Comprueba el cableado
// de los manejadores en el arranque y que el cierre ordenado por SIGTERM/SIGINT sigue saliendo con código 0.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
const RAIZ = fileURLToPath(new URL("../..", import.meta.url));
const PRECARGA = fileURLToPath(new URL("../../test-aux/fallo-tras-arranque.js", import.meta.url));

/** Arranca server.js. `esperar(salida)` decide cuándo está listo; devuelve { hijo, salida, terminado: Promise<{codigo, senal}> }. */
function arrancar({ precarga = false, extraEnv = {} } = {}) {
    const hijo = spawn(
        process.execPath,
        [...(precarga ? ["--import", PRECARGA] : []), "server.js"],
        {
            cwd: RAIZ,
            env: {
                PATH: process.env.PATH,
                NODE_ENV: "test",
                DATABASE_URL: DB,
                JWT_SECRET: process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok",
                PORT: "0",
                ...extraEnv,
            },
        },
    );
    const estado = { salida: "" };
    hijo.stdout.on("data", (d) => (estado.salida += d));
    hijo.stderr.on("data", (d) => (estado.salida += d));
    const terminado = new Promise((resolver) =>
        hijo.on("exit", (codigo, senal) => resolver({ codigo, senal })),
    );
    const listo = new Promise((resolver, rechazar) => {
        const t = setTimeout(
            () => rechazar(new Error(`el servidor no arrancó en 15 s:\n${estado.salida}`)),
            15000,
        );
        const mira = setInterval(() => {
            if (estado.salida.includes("Servidor corriendo")) {
                clearTimeout(t);
                clearInterval(mira);
                resolver();
            }
        }, 50);
        terminado.then(() => {
            clearTimeout(t);
            clearInterval(mira);
            rechazar(new Error(`el servidor terminó antes de arrancar:\n${estado.salida}`));
        });
    });
    // Evita un «unhandled rejection» de `listo` si nadie lo espera (cuando el proceso termina por su cuenta).
    listo.catch(() => {});
    return { hijo, estado, terminado, listo };
}

const lineasJson = (salida) =>
    salida
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));

/** Servidor local que hace de «Sentry»: guarda lo que le llega. */
async function sentryLocal() {
    const recibidos = [];
    const srv = http.createServer((req, res) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
            recibidos.push(b);
            res.end("{}");
        });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return {
        recibidos,
        dsn: `http://clavePublica@127.0.0.1:${srv.address().port}/1`,
        cerrar: () => new Promise((r) => srv.close(r)),
    };
}

describe("server.js real", { skip: SKIP }, () => {
    it("un rechazo sin catch con el servidor en marcha: queda en el log, cierra en orden y sale con código 1", async () => {
        const s = arrancar({ precarga: true });
        const { codigo } = await Promise.race([
            s.terminado,
            new Promise((_, rechazar) =>
                setTimeout(() => {
                    s.hijo.kill("SIGKILL");
                    rechazar(
                        new Error(`el servidor siguió vivo tras el error:\n${s.estado.salida}`),
                    );
                }, 20000),
            ),
        ]);
        assert.equal(codigo, 1, s.estado.salida);
        const lineas = lineasJson(s.estado.salida);
        const fatal = lineas.find((l) => l.message === "unhandled_rejection");
        assert.ok(fatal, `sin línea unhandled_rejection:\n${s.estado.salida}`);
        assert.equal(fatal.level, "error");
        assert.match(fatal.error, /fallo-provocado-por-la-prueba/);
        assert.match(fatal.stack, /fallo-tras-arranque/);
        assert.ok(
            lineas.some((l) => l.message === "cierre_ordenado"),
            "cerró en orden",
        );
        assert.equal(
            lineas.some((l) => l.message === "cierre_forzado"),
            false,
            "sin forzar",
        );
    });

    it("SIGTERM sigue siendo un cierre limpio con código 0", async () => {
        const s = arrancar();
        await s.listo;
        s.hijo.kill("SIGTERM");
        const { codigo } = await s.terminado;
        assert.equal(codigo, 0, s.estado.salida);
        assert.match(s.estado.salida, /SIGTERM recibido/);
        assert.match(s.estado.salida, /cerrados correctamente/);
        assert.equal(
            lineasJson(s.estado.salida).some((l) => l.message === "unhandled_rejection"),
            false,
        );
    });

    it("con SENTRY_DSN, un fallo fatal llega a Sentry ANTES de salir (código 1) y sin datos de personas", async () => {
        const sentry = await sentryLocal();
        try {
            const s = arrancar({ precarga: true, extraEnv: { SENTRY_DSN: sentry.dsn } });
            const { codigo } = await s.terminado;
            assert.equal(codigo, 1, s.estado.salida);
            const lineas = lineasJson(s.estado.salida);
            assert.ok(
                lineas.some((l) => l.message === "sentry_activo"),
                "Sentry se encendió",
            );
            assert.ok(lineas.some((l) => l.message === "cierre_ordenado"));
            assert.equal(sentry.recibidos.length, 1, "llegó el evento antes de salir");
            const cuerpo = sentry.recibidos[0];
            assert.match(cuerpo, /fallo-provocado-por-la-prueba/);
            assert.match(cuerpo, /"tipo":"unhandled_rejection"/);
            assert.equal(JSON.parse(cuerpo.split("\n")[2]).server_name, "api");
        } finally {
            await sentry.cerrar();
        }
    });

    it("con SENTRY_DSN pero sin fallos, SIGTERM sigue siendo un cierre limpio (código 0) y no envía nada", async () => {
        const sentry = await sentryLocal();
        try {
            const s = arrancar({ extraEnv: { SENTRY_DSN: sentry.dsn } });
            await s.listo;
            s.hijo.kill("SIGTERM");
            const { codigo } = await s.terminado;
            assert.equal(codigo, 0, s.estado.salida);
            assert.equal(sentry.recibidos.length, 0);
        } finally {
            await sentry.cerrar();
        }
    });

    it("un SENTRY_DSN inválido no impide arrancar: queda registrado y el servidor funciona", async () => {
        const s = arrancar({ extraEnv: { SENTRY_DSN: "esto-no-es-un-dsn" } });
        await s.listo;
        s.hijo.kill("SIGTERM");
        const { codigo } = await s.terminado;
        assert.equal(codigo, 0, s.estado.salida);
        const lineas = lineasJson(s.estado.salida);
        assert.equal(
            lineas.some((l) => l.message === "sentry_activo"),
            false,
        );
    });
});
