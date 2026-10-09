import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    enmascararCorreo,
    limpiarTexto,
    limpiarContexto,
    rutaSegura,
} from "../src/utils/redactar.js";
import { logger } from "../src/utils/logger.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { requestLogger } from "../src/middlewares/requestLogger.js";
import { EventEmitter } from "node:events";

// Lo que llega a los logs no debe contener secretos ni datos personales en claro. Sin base de datos.

const TOKEN = "Zk3pQ9vXw2LmN8aRtY5uHb7cDe1FgJiK0oPsTqVxWyA"; // 43 caracteres, como los de invitación

/** Captura lo que el logger escribe y lo devuelve como texto plano (todas las líneas). */
function capturar(fn) {
    const salida = [];
    mock.method(console, "log", (l) => salida.push(l));
    mock.method(console, "error", (l) => salida.push(l));
    try {
        fn();
    } finally {
        mock.restoreAll();
    }
    return salida.join("\n");
}

describe("enmascararCorreo / limpiarTexto", () => {
    it("deja la primera letra y el dominio, y tapa el resto de la persona", () => {
        assert.equal(enmascararCorreo("carlos@cafearoma.com"), "c***@cafearoma.com");
        assert.equal(
            enmascararCorreo("de a.b+c@x.mx para otra@y.com.mx"),
            "de a***@x.mx para o***@y.com.mx",
        );
    });

    it("limpia correos, JWT, cabeceras Bearer, credenciales en URL y valores del detalle de PostgreSQL", () => {
        const sucio = [
            "falló para dueño@empresa.mx",
            "token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MTIzNDU2fQ.firmaDelToken-123",
            "Authorization: Bearer abc.DEF_123-xyz",
            "smtps://usuario:claveSecreta@smtp.proveedor.com",
            "postgres://gh_app:otraClave@127.0.0.1:5432/inventarios",
            "Key (email)=(ana@correo.com) already exists.",
        ].join(" | ");
        const limpio = limpiarTexto(sucio);
        for (const secreto of [
            "dueño@empresa.mx",
            "eyJpZCI6MTIzNDU2fQ",
            "abc.DEF_123-xyz",
            "claveSecreta",
            "otraClave",
            "ana@correo.com",
        ])
            assert.equal(limpio.includes(secreto), false, `quedó «${secreto}» en: ${limpio}`);
        // Las credenciales de una URL se quitan enteras (usuario y clave), no a medias
        assert.match(limpio, /smtps:\/\/\*\*\*@smtp\.proveedor\.com/);
        assert.match(limpio, /postgres:\/\/\*\*\*@127\.0\.0\.1:5432\/inventarios/);
        for (const resto of ["usuario:", "gh_app:"])
            assert.equal(limpio.includes(resto), false, `quedó «${resto}» en: ${limpio}`);
        // Se conserva lo útil para depurar
        assert.match(limpio, /d\*\*\*@empresa\.mx/);
        assert.match(limpio, /\(email\)=\(\*\*\*\)/);
        assert.match(limpio, /smtp\.proveedor\.com/);
    });

    it("un texto sin datos sensibles no cambia", () => {
        const normal = "Error: connection terminated unexpectedly (3 reintentos)";
        assert.equal(limpiarTexto(normal), normal);
    });
});

describe("rutaSegura", () => {
    it("sin query: quita los valores y deja solo los NOMBRES de los parámetros", () => {
        const { path, query_keys } = rutaSegura(
            "/api/productos/4?q=carlos%40mail.com&desde=2026-01-01",
        );
        assert.equal(path, "/api/productos/4");
        assert.deepEqual(query_keys, ["q", "desde"]);
        assert.equal(JSON.stringify({ path, query_keys }).includes("carlos"), false);
    });

    it("enmascara el token de una invitación (la ruta lo marca como secreto aunque sea corto o mal formado)", () => {
        assert.equal(
            rutaSegura(`/api/auth/invitacion/${TOKEN}`).path,
            "/api/auth/invitacion/:token",
        );
        assert.equal(rutaSegura("/api/auth/invitacion/corto").path, "/api/auth/invitacion/:token");
        assert.equal(
            rutaSegura(`/api/auth/invitacion/${TOKEN}?x=1`).path,
            "/api/auth/invitacion/:token",
        );
    });

    it("enmascara cualquier segmento opaco de 24+ caracteres, aunque la ruta no se conozca", () => {
        assert.equal(
            rutaSegura(`/api/algo-nuevo/${TOKEN}/detalle`).path,
            "/api/algo-nuevo/:token/detalle",
        );
    });

    it("no toca las rutas normales ni los segmentos largos legibles (el más largo de la API mide 19)", () => {
        for (const ruta of [
            "/api/platform/empresas/12/reenviar-invitacion",
            "/api/platform/empresas/12/resetear-password",
            "/api/usuarios/4/9/pin/desbloquear",
            "/api/auth/empresa-activa",
            "/health/ready",
        ])
            assert.equal(rutaSegura(ruta).path, ruta);
    });

    it("sin query no hay query_keys, y las claves están acotadas", () => {
        assert.deepEqual(rutaSegura("/api/x").query_keys, []);
        const muchas = Array.from({ length: 100 }, (_, i) => `k${i}=1`).join("&");
        assert.equal(rutaSegura(`/api/x?${muchas}`).query_keys.length, 20);
        assert.equal(rutaSegura(`/api/x?${"a".repeat(500)}=1`).query_keys[0].length <= 40, true);
    });
});

describe("limpiarContexto", () => {
    it("tapa los campos secretos por nombre, en cualquier nivel, y no modifica el original", () => {
        const original = {
            usuario_id: 7,
            password: "ClaveSecreta1",
            password_hash: "$2a$10$abc",
            token: TOKEN,
            token_hash: "deadbeef",
            authorization: "Bearer x",
            cookie: "gh_session=abc",
            pin: "1234",
            codigo: "ABCD-EFGH",
            codigo_ingreso: "NOR01",
            anidado: { api_key: "k", secret: "s", lista: [{ "set-cookie": "a" }] },
        };
        const copia = limpiarContexto(original);
        assert.equal(copia.usuario_id, 7);
        for (const k of [
            "password",
            "password_hash",
            "token",
            "token_hash",
            "authorization",
            "cookie",
            "pin",
            "codigo",
            "codigo_ingreso",
        ])
            assert.equal(copia[k], "[redactado]", k);
        assert.equal(copia.anidado.api_key, "[redactado]");
        assert.equal(copia.anidado.secret, "[redactado]");
        assert.equal(copia.anidado.lista[0]["set-cookie"], "[redactado]");
        assert.equal(original.password, "ClaveSecreta1", "el original no cambia");
    });

    it("no tapa campos que solo se parecen: ip, requestId, usuario_id, token_version, tipo", () => {
        const copia = limpiarContexto({
            ip: "1.2.3.4",
            requestId: "abc",
            usuario_id: 1,
            tipo: "x",
            pinned: true,
        });
        assert.deepEqual(copia, {
            ip: "1.2.3.4",
            requestId: "abc",
            usuario_id: 1,
            tipo: "x",
            pinned: true,
        });
    });

    it("sanea los textos y los Error anidados", () => {
        const copia = limpiarContexto({
            error: new Error("falló para a@b.com"),
            lista: ["x@y.mx"],
        });
        assert.equal(copia.error.message, "falló para a***@b.com");
        assert.equal(copia.error.stack.includes("a@b.com"), false);
        assert.deepEqual(copia.lista, ["x***@y.mx"]);
    });

    it("una estructura circular o muy profunda no cuelga ni revienta", () => {
        const a = { nombre: "a" };
        a.yo = a;
        const copia = limpiarContexto(a);
        assert.equal(typeof JSON.stringify(copia), "string");
    });
});

describe("el logger sanea todo lo que se le pasa", () => {
    afterEach(() => mock.restoreAll());

    it("una línea de log nunca lleva la contraseña, el token ni el correo en claro", () => {
        const texto = capturar(() =>
            logger.error("falló el login de ana@correo.com", {
                password: "ClaveSecreta1",
                token: TOKEN,
                error: "Key (email)=(ana@correo.com) already exists.",
                req: { headers: { authorization: `Bearer ${TOKEN}`, cookie: "gh_session=x" } },
            }),
        );
        for (const secreto of ["ClaveSecreta1", TOKEN, "ana@correo.com", "gh_session=x"])
            assert.equal(texto.includes(secreto), false, `quedó «${secreto}»: ${texto}`);
        assert.doesNotThrow(() => JSON.parse(texto), "sigue siendo JSON válido");
    });

    it("db_error del manejador de errores: ni el valor duplicado ni el correo salen en el log", () => {
        const texto = capturar(() => {
            let cuerpo;
            const res = {
                status() {
                    return this;
                },
                json(b) {
                    cuerpo = b;
                },
            };
            errorHandler(
                { code: "23505", detail: "Key (email)=(ana@correo.com) already exists." },
                { id: "req-12345678" },
                res,
                () => {},
            );
            assert.equal(JSON.stringify(cuerpo).includes("ana@"), false);
        });
        assert.equal(texto.includes("ana@correo.com"), false, texto);
        assert.match(texto, /\(email\)=\(\*\*\*\)/);
    });

    it("el 500 inesperado: el stack y el mensaje salen saneados", () => {
        const texto = capturar(() => {
            const res = {
                status() {
                    return this;
                },
                json() {},
            };
            errorHandler(
                new Error("falló con ana@correo.com y Bearer abc.def"),
                { id: "r-123456789" },
                res,
                () => {},
            );
        });
        assert.equal(texto.includes("ana@correo.com"), false);
        assert.equal(texto.includes("abc.def"), false);
    });
});

describe("la línea de petición no guarda tokens ni queries", () => {
    afterEach(() => mock.restoreAll());

    it("GET de una invitación y una búsqueda con correo: ni el token ni el correo aparecen", () => {
        const lineas = [];
        mock.method(console, "log", (l) => lineas.push(l));
        mock.method(console, "error", (l) => lineas.push(l));
        for (const url of [
            `/api/auth/invitacion/${TOKEN}`,
            "/api/usuarios/4?q=ana%40correo.com&email=ana@correo.com",
        ]) {
            const req = { method: "GET", originalUrl: url, ip: "1.1.1.1", get: () => undefined };
            const res = new EventEmitter();
            res.setHeader = () => {};
            res.statusCode = 200;
            requestLogger(req, res, () => {});
            res.emit("finish");
        }
        const texto = lineas.join("\n");
        assert.equal(texto.includes(TOKEN), false, texto);
        assert.equal(texto.includes("ana"), false, texto);
        assert.match(texto, /\/api\/auth\/invitacion\/:token/);
        assert.match(texto, /"query_keys":\["q","email"\]/);
    });
});
