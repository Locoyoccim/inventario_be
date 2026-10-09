import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { crearManejadoresFatales, PLAZO_CIERRE_MS } from "../src/utils/procesoFatal.js";

// Manejadores de errores que nadie capturó, con dobles: el proceso real se prueba en proceso-fatal-real.test.js.

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function entorno({ cerrar = async () => {}, plazoMs = 40 } = {}) {
    const lineas = [];
    const salidas = [];
    const registro =
        (nivel) =>
        (mensaje, datos = {}) =>
            lineas.push({ nivel, mensaje, ...datos });
    const log = { info: registro("info"), warn: registro("warn"), error: registro("error") };
    const manejadores = crearManejadoresFatales({
        cerrar,
        salir: (codigo) => salidas.push(codigo),
        plazoMs,
        log,
    });
    return { ...manejadores, lineas, salidas };
}

describe("manejadores de errores fatales", () => {
    afterEach(() => mock.restoreAll());

    it("una promesa rechazada se registra con su stack, se cierra en orden y se sale con código 1", async () => {
        let cerrado = 0;
        const e = entorno({
            cerrar: async () => {
                cerrado++;
            },
        });
        e.fatal("unhandled_rejection", new Error("se rompió algo"));
        await espera(10);
        const l = e.lineas.find((x) => x.mensaje === "unhandled_rejection");
        assert.equal(l.nivel, "error");
        assert.equal(l.error, "se rompió algo");
        assert.match(l.stack, /se rompió algo/);
        assert.equal(cerrado, 1);
        assert.ok(e.lineas.some((x) => x.mensaje === "cierre_ordenado"));
        assert.deepEqual(e.salidas, [1]);
    });

    it("una excepción no capturada hace lo mismo y lo deja dicho en el tipo", async () => {
        const e = entorno();
        e.fatal("uncaught_exception", new TypeError("x is not a function"));
        await espera(10);
        assert.equal(e.lineas[0].mensaje, "uncaught_exception");
        assert.deepEqual(e.salidas, [1]);
    });

    it("se puede rechazar con algo que no es un Error (texto, objeto, nada) sin que el manejador falle", async () => {
        for (const valor of ["texto suelto", { codigo: 7 }, undefined, null, 42]) {
            const e = entorno();
            assert.doesNotThrow(() => e.fatal("unhandled_rejection", valor), String(valor));
            await espera(5);
            assert.equal(e.lineas[0].stack, undefined);
            assert.equal(typeof e.lineas[0].error, "string");
            assert.deepEqual(e.salidas, [1]);
        }
    });

    it("un texto muy largo no llena el log", async () => {
        const e = entorno();
        e.fatal("unhandled_rejection", "x".repeat(10000));
        await espera(5);
        assert.equal(e.lineas[0].error.length, 500);
    });

    it("si el cierre se cuelga, se sale igual al cumplirse el plazo", async () => {
        const e = entorno({ cerrar: () => new Promise(() => {}), plazoMs: 30 });
        e.fatal("uncaught_exception", new Error("x"));
        await espera(10);
        assert.deepEqual(e.salidas, [], "aún dentro del plazo");
        await espera(60);
        assert.ok(e.lineas.some((x) => x.mensaje === "cierre_forzado"));
        assert.deepEqual(e.salidas, [1]);
    });

    it("si el cierre falla, se registra y se sale igual", async () => {
        const e = entorno({
            cerrar: async () => {
                throw new Error("la base no responde");
            },
        });
        e.fatal("unhandled_rejection", new Error("x"));
        await espera(10);
        const l = e.lineas.find((x) => x.mensaje === "cierre_fallido");
        assert.equal(l.error, "la base no responde");
        assert.deepEqual(e.salidas, [1]);
    });

    it("un segundo error mientras se cierra sale de inmediato, sin esperar más", async () => {
        const e = entorno({ cerrar: () => new Promise(() => {}), plazoMs: 5000 });
        e.fatal("unhandled_rejection", new Error("primero"));
        assert.deepEqual(e.salidas, []);
        e.fatal("uncaught_exception", new Error("segundo"));
        assert.deepEqual(e.salidas, [1], "no espera los 5 s del plazo");
        assert.ok(e.lineas.some((x) => x.mensaje === "fatal_repetido"));
    });

    it("el cierre se pide una sola vez aunque lleguen varios errores", async () => {
        let cerrado = 0;
        const e = entorno({
            cerrar: async () => {
                cerrado++;
                await espera(20);
            },
        });
        e.fatal("unhandled_rejection", new Error("a"));
        e.fatal("unhandled_rejection", new Error("b"));
        await espera(50);
        assert.equal(cerrado, 1);
    });

    it("instalar engancha unhandledRejection y uncaughtException al emisor que se le da (no al proceso real)", async () => {
        const e = entorno();
        const falso = new EventEmitter();
        const realesAntes = process.listenerCount("unhandledRejection");
        e.instalar(falso);
        assert.equal(falso.listenerCount("unhandledRejection"), 1);
        assert.equal(falso.listenerCount("uncaughtException"), 1);
        assert.equal(process.listenerCount("unhandledRejection"), realesAntes);
        falso.emit("unhandledRejection", new Error("desde el emisor"));
        await espera(10);
        assert.equal(e.lineas[0].mensaje, "unhandled_rejection");
        assert.deepEqual(e.salidas, [1]);
    });
});

describe("plazo de cierre por defecto", () => {
    it("es corto (Railway da ~10 s tras la señal de cierre y un proceso en estado dudoso no debe quedarse esperando)", () => {
        assert.ok(PLAZO_CIERRE_MS >= 1000 && PLAZO_CIERRE_MS <= 5000, String(PLAZO_CIERRE_MS));
    });

    it("sin plazoMs explícito se usa ese valor", async () => {
        const salidas = [];
        const { fatal } = crearManejadoresFatales({
            cerrar: () => new Promise(() => {}),
            salir: (c) => salidas.push(c),
            log: { info() {}, warn() {}, error() {} },
        });
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            fatal("uncaught_exception", new Error("x"));
            mock.timers.tick(PLAZO_CIERRE_MS - 1);
            assert.deepEqual(salidas, []);
            mock.timers.tick(1);
            assert.deepEqual(salidas, [1]);
        } finally {
            mock.timers.reset();
        }
    });
});

describe("el log del fatal sale saneado", () => {
    afterEach(() => mock.restoreAll());

    it("con el logger real, un correo en el mensaje y en el stack no llega a la línea", async () => {
        const lineas = [];
        mock.method(console, "log", (l) => lineas.push(l));
        mock.method(console, "error", (l) => lineas.push(l));
        const salidas = [];
        const { fatal } = crearManejadoresFatales({
            cerrar: async () => {},
            salir: (c) => salidas.push(c),
            plazoMs: 30,
        });
        fatal(
            "unhandled_rejection",
            new Error("fallo al avisar a ana@correo.com con Bearer abc.def"),
        );
        await espera(10);
        const texto = lineas.join("\n");
        assert.equal(texto.includes("ana@correo.com"), false);
        assert.equal(texto.includes("abc.def"), false);
        assert.match(texto, /unhandled_rejection/);
    });
});
