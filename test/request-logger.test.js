import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { requestLogger, idDePeticion } from "../src/middlewares/requestLogger.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

// Sin base de datos: el middleware se prueba con una petición y una respuesta simuladas, y el log se captura.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function peticion({ cabecera, url = "/api/productos/1", user, ip = "203.0.113.7" } = {}) {
    return {
        method: "GET",
        originalUrl: url,
        ip,
        user,
        get: (nombre) => (nombre.toLowerCase() === "x-request-id" ? cabecera : undefined),
    };
}
function respuesta() {
    const res = new EventEmitter();
    res.cabeceras = {};
    res.setHeader = (k, v) => {
        res.cabeceras[k] = v;
    };
    res.statusCode = 200;
    return res;
}
/** Ejecuta el middleware, termina la respuesta con `status` y devuelve las líneas de log (objetos) que salieron. */
function correr(req, status) {
    const lineas = [];
    const captura = (l) => lineas.push(JSON.parse(l));
    mock.method(console, "log", captura);
    mock.method(console, "error", captura);
    const res = respuesta();
    requestLogger(req, res, () => {});
    res.statusCode = status;
    res.emit("finish");
    return { req, res, lineas };
}

describe("X-Request-Id", () => {
    afterEach(() => mock.restoreAll());

    it("acepta un id entrante con forma válida y lo devuelve en la cabecera", () => {
        const { req, res } = correr(peticion({ cabecera: "abc12345-req.id_X" }), 200);
        assert.equal(req.id, "abc12345-req.id_X");
        assert.equal(res.cabeceras["X-Request-Id"], "abc12345-req.id_X");
    });

    it("sin id entrante genera uno nuevo (UUID) y también lo devuelve", () => {
        const { req, res } = correr(peticion(), 200);
        assert.match(req.id, UUID);
        assert.equal(res.cabeceras["X-Request-Id"], req.id);
    });

    it("un id entrante inválido se reemplaza: saltos de línea, texto libre, muy corto o muy largo, tipos raros", () => {
        const invalidos = [
            "corto",
            "a".repeat(65),
            "id con espacios 123",
            "linea1\nlinea2-abcdef",
            'x","level":"error","message":"falso',
            "<script>alert(1)</script>",
            "",
            ["abcdefgh12", "otro-id-1234"],
            undefined,
            null,
        ];
        for (const cabecera of invalidos) {
            const id = idDePeticion(cabecera);
            assert.match(id, UUID, `no se debe aceptar ${JSON.stringify(cabecera)}`);
        }
    });

    it("el límite exacto: 8 y 64 caracteres sí; 7 y 65 no", () => {
        assert.equal(idDePeticion("a".repeat(8)), "a".repeat(8));
        assert.equal(idDePeticion("a".repeat(64)), "a".repeat(64));
        assert.match(idDePeticion("a".repeat(7)), UUID);
        assert.match(idDePeticion("a".repeat(65)), UUID);
    });
});

describe("línea de log por petición", () => {
    afterEach(() => mock.restoreAll());

    it("lleva id, usuario, empresa activa e IP; sin sesión, usuario y empresa van en null", () => {
        const con = correr(peticion({ user: { id: 7, empresa_id: 12 } }), 200).lineas[0];
        assert.equal(con.message, "request");
        assert.equal(con.requestId.length > 0, true);
        assert.equal(con.usuario_id, 7);
        assert.equal(con.empresa_id, 12);
        assert.equal(con.ip, "203.0.113.7");
        assert.equal(con.status, 200);
        mock.restoreAll();
        const sin = correr(peticion(), 200).lineas[0];
        assert.equal(sin.usuario_id, null);
        assert.equal(sin.empresa_id, null);
    });

    it("el nivel sigue al status: 2xx/3xx info, 4xx warn, 5xx error", () => {
        const nivel = (status) => {
            mock.restoreAll();
            return correr(peticion(), status).lineas[0].level;
        };
        assert.equal(nivel(200), "info");
        assert.equal(nivel(304), "info");
        assert.equal(nivel(400), "warn");
        assert.equal(nivel(401), "warn");
        assert.equal(nivel(429), "warn");
        assert.equal(nivel(500), "error");
        assert.equal(nivel(503), "error");
    });

    it("las consultas de salud correctas no se registran (los monitores las repiten cada minuto); las que fallan, sí", () => {
        assert.equal(correr(peticion({ url: "/health" }), 200).lineas.length, 0);
        mock.restoreAll();
        assert.equal(correr(peticion({ url: "/health/ready?x=1" }), 200).lineas.length, 0);
        mock.restoreAll();
        const caida = correr(peticion({ url: "/health/ready" }), 503).lineas;
        assert.equal(caida.length, 1);
        assert.equal(caida[0].level, "error");
        mock.restoreAll();
        assert.equal(correr(peticion({ url: "/api/healthcheck-falso" }), 200).lineas.length, 1);
    });
});

describe("error 500", () => {
    afterEach(() => mock.restoreAll());

    it("devuelve el requestId (para buscarlo en los logs) y nunca el mensaje ni el stack internos", () => {
        mock.method(console, "error", () => {});
        let cuerpo;
        const res = {
            status(c) {
                this.codigo = c;
                return this;
            },
            json(b) {
                cuerpo = b;
            },
        };
        errorHandler(new Error("detalle interno SECRETO"), { id: "req-id-12345" }, res, () => {});
        assert.equal(res.codigo, 500);
        assert.deepEqual(cuerpo, {
            success: false,
            error: "Error interno del servidor",
            requestId: "req-id-12345",
        });
        assert.equal(JSON.stringify(cuerpo).includes("SECRETO"), false);
    });
});
