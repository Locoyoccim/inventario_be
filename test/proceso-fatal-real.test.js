import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Con procesos de verdad: lo que ocurre cuando algo no se captura. El proceso debe dejar el error en el log, cerrar y salir con código 1
// (para que el orquestador lo reinicie), nunca seguir vivo en un estado dudoso.

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const HIJO = fileURLToPath(new URL("../test-aux/fatal-hijo.js", import.meta.url));

function correr(escenario, { limiteMs = 5000 } = {}) {
    return new Promise((resolver, rechazar) => {
        const t0 = Date.now();
        const hijo = spawn(process.execPath, [HIJO, escenario], {
            cwd: RAIZ,
            env: { PATH: process.env.PATH, NODE_ENV: "test" },
        });
        let salida = "";
        hijo.stdout.on("data", (d) => (salida += d));
        hijo.stderr.on("data", (d) => (salida += d));
        const reloj = setTimeout(() => {
            hijo.kill("SIGKILL");
            rechazar(
                new Error(
                    `el proceso no terminó solo en ${limiteMs} ms (¿sigue vivo tras el error?):\n${salida}`,
                ),
            );
        }, limiteMs);
        hijo.on("exit", (codigo, senal) => {
            clearTimeout(reloj);
            const lineas = salida
                .split("\n")
                .filter((l) => l.startsWith("{"))
                .map((l) => JSON.parse(l));
            resolver({ codigo, senal, ms: Date.now() - t0, lineas, salida });
        });
    });
}

describe("proceso real ante un error que nadie capturó", () => {
    it("una promesa rechazada sin catch: queda en el log (saneado), cierra en orden y sale con código 1", async () => {
        const r = await correr("rechazo");
        assert.equal(r.codigo, 1);
        const l = r.lineas.find((x) => x.message === "unhandled_rejection");
        assert.ok(l, `sin línea unhandled_rejection:\n${r.salida}`);
        assert.equal(l.level, "error");
        assert.match(l.stack, /rechazo-de-prueba/);
        assert.match(l.error, /rechazo-de-prueba/);
        assert.equal(r.salida.includes("ana@correo.com"), false, "el correo no sale en claro");
        assert.ok(r.lineas.some((x) => x.message === "cierre_ordenado"));
    });

    it("una excepción no capturada: mismo resultado", async () => {
        const r = await correr("excepcion");
        assert.equal(r.codigo, 1);
        assert.ok(
            r.lineas.some((x) => x.message === "uncaught_exception"),
            r.salida,
        );
        assert.equal(r.salida.includes("ana@correo.com"), false);
    });

    it("rechazar con algo que no es un Error (un texto) tampoco deja el proceso vivo ni lo hace fallar a medias", async () => {
        const r = await correr("rechazo-no-error");
        assert.equal(r.codigo, 1);
        const l = r.lineas.find((x) => x.message === "unhandled_rejection");
        assert.equal(l.stack, undefined);
        assert.match(JSON.stringify(l), /texto-suelto-de-prueba/);
    });

    it("si el cierre se cuelga, el proceso sale al cumplirse el plazo (no se queda colgado)", async () => {
        const r = await correr("cierre-colgado", { limiteMs: 6000 });
        assert.equal(r.codigo, 1);
        assert.ok(
            r.lineas.some((x) => x.message === "cierre_forzado"),
            r.salida,
        );
        assert.ok(r.ms >= 400, `salió antes del plazo (${r.ms} ms)`);
        assert.ok(r.ms < 3000, `tardó demasiado (${r.ms} ms)`);
    });
});
