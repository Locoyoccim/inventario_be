import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/utils/logger.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

// El nombre del evento (`message`) es lo que se busca y por lo que se alerta: el contexto no puede pisarlo. Sin base de datos.

function capturar() {
    const lineas = [];
    mock.method(console, "log", (l) => lineas.push(JSON.parse(l)));
    mock.method(console, "error", (l) => lineas.push(JSON.parse(l)));
    return lineas;
}

describe("logger: el contexto no pisa el nombre del evento", () => {
    afterEach(() => mock.restoreAll());

    it("un contexto con `message`, `level` o `ts` no cambia la línea; el `message` del llamador pasa a `detalle`", () => {
        const lineas = capturar();
        logger.error("unhandled_rejection", {
            message: "texto del error",
            level: "info",
            ts: "ayer",
            otro: 1,
        });
        const l = lineas[0];
        assert.equal(l.message, "unhandled_rejection");
        assert.equal(l.level, "error");
        assert.notEqual(l.ts, "ayer");
        assert.equal(l.detalle, "texto del error");
        assert.equal(l.otro, 1);
    });

    it("sin colisión no aparece `detalle`", () => {
        const lineas = capturar();
        logger.info("request", { status: 200 });
        assert.equal("detalle" in lineas[0], false);
    });

    it("un `detalle` con datos sensibles sigue saneado", () => {
        const lineas = capturar();
        logger.warn("x", { message: "falló para ana@correo.com" });
        assert.equal(lineas[0].detalle, "falló para a***@correo.com");
    });
});

describe("el 500 inesperado conserva su nombre de evento", () => {
    afterEach(() => mock.restoreAll());

    it("la línea se llama unhandled_error y el texto del error va en `error`", () => {
        const lineas = capturar();
        const res = {
            status() {
                return this;
            },
            json() {},
        };
        errorHandler(new Error("algo inesperado"), { id: "req-12345678" }, res, () => {});
        const l = lineas.find((x) => x.message === "unhandled_error");
        assert.ok(l, "debe existir la línea unhandled_error");
        assert.equal(l.error, "algo inesperado");
        assert.match(l.stack, /algo inesperado/);
        assert.equal(l.requestId, "req-12345678");
    });
});
