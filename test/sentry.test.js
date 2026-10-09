import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    iniciarSentry,
    capturarError,
    vaciarSentry,
    limpiarEvento,
    opcionesSentry,
    reiniciarSentryParaPruebas,
    sentryActivo,
} from "../src/utils/sentry.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import ApiError from "../src/utils/ApiError.js";
import { crearManejadoresFatales } from "../src/utils/procesoFatal.js";

// Sentry: apagado salvo con SENTRY_DSN, y aun encendido sin datos de personas. Sin base de datos.

const DSN = "https://clave@o0.ingest.example.com/1";

/** Un SDK de mentira que anota lo que se le pide. */
function sdkDoble({ falla = {} } = {}) {
    const llamadas = { init: [], tags: [], capturas: [], flush: [] };
    const sdk = {
        init: (o) => {
            if (falla.init) throw new Error("init roto");
            llamadas.init.push(o);
        },
        withScope: (fn) => {
            if (falla.withScope) throw new Error("scope roto");
            fn({ setTag: (k, v) => llamadas.tags.push([k, v]) });
        },
        captureException: (e) => llamadas.capturas.push(e),
        isEnabled: () => !falla.deshabilitado,
        flush: async (ms) => {
            if (falla.flush) throw new Error("flush roto");
            llamadas.flush.push(ms);
            return true;
        },
    };
    return { sdk, llamadas };
}
const log = () => {
    const lineas = [];
    const r =
        (nivel) =>
        (mensaje, datos = {}) =>
            lineas.push({ nivel, mensaje, ...datos });
    return { lineas, log: { info: r("info"), warn: r("warn"), error: r("error") } };
};

describe("Sentry apagado", () => {
    afterEach(() => reiniciarSentryParaPruebas());

    it("sin SENTRY_DSN (o vacío, o solo espacios) no importa el paquete, no queda activo y las demás funciones no hacen nada", async () => {
        for (const env of [{}, { SENTRY_DSN: "" }, { SENTRY_DSN: "   " }]) {
            let importado = 0;
            const r = await iniciarSentry({
                env,
                importar: async () => {
                    importado++;
                    return sdkDoble().sdk;
                },
            });
            assert.equal(r, false);
            assert.equal(importado, 0, "el paquete no se carga sin DSN");
            assert.equal(sentryActivo(), false);
        }
        assert.doesNotThrow(() => capturarError(new Error("x"), { tipo: "t" }));
        assert.equal(await vaciarSentry(10), false);
    });

    it("el código no importa @sentry/* de forma estática (así el paquete solo se carga cuando hay DSN)", () => {
        const archivos = (dir) =>
            readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
                e.isDirectory()
                    ? archivos(join(dir, e.name))
                    : e.name.endsWith(".js")
                      ? [join(dir, e.name)]
                      : [],
            );
        const estaticos = [...archivos("src"), "server.js"].filter((f) =>
            /^\s*import[^(]*from\s+["']@sentry\//m.test(readFileSync(f, "utf8")),
        );
        assert.deepEqual(estaticos, [], `import estático de @sentry en: ${estaticos}`);
    });
});

describe("Sentry encendido (con un SDK doble)", () => {
    afterEach(() => reiniciarSentryParaPruebas());

    it("init recibe todo el contexto personal apagado y sin integraciones por defecto", async () => {
        const { sdk, llamadas } = sdkDoble();
        const l = log();
        const r = await iniciarSentry({
            env: {
                SENTRY_DSN: ` ${DSN} `,
                NODE_ENV: "production",
                RAILWAY_GIT_COMMIT_SHA: "abc123",
            },
            importar: async () => sdk,
            log: l.log,
        });
        assert.equal(r, true);
        assert.equal(sentryActivo(), true);
        assert.equal(llamadas.init.length, 1);
        const o = llamadas.init[0];
        assert.equal(o.dsn, DSN, "el DSN se recorta");
        assert.equal(o.environment, "production");
        assert.equal(o.release, "abc123");
        assert.equal(o.defaultIntegrations, false);
        assert.deepEqual(o.integrations, []);
        assert.deepEqual(o.dataCollection, {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
        });
        assert.equal(o.serverName, "api");
        assert.equal(typeof o.beforeSend, "function");
        assert.equal("tracesSampleRate" in o, false, "sin trazas de rendimiento");
        assert.equal(l.lineas[0].mensaje, "sentry_activo");
    });

    it("SENTRY_ENVIRONMENT y SENTRY_RELEASE mandan sobre los valores por defecto", () => {
        const o = opcionesSentry({
            SENTRY_DSN: DSN,
            NODE_ENV: "production",
            SENTRY_ENVIRONMENT: "staging",
            SENTRY_RELEASE: "v1.2",
            RAILWAY_GIT_COMMIT_SHA: "abc",
        });
        assert.equal(o.environment, "staging");
        assert.equal(o.release, "v1.2");
    });

    it("si el paquete no carga o init falla: false, queda registrado y NO lanza (no impide arrancar)", async () => {
        const a = log();
        assert.equal(
            await iniciarSentry({
                env: { SENTRY_DSN: DSN },
                importar: async () => {
                    throw new Error("Cannot find package");
                },
                log: a.log,
            }),
            false,
        );
        assert.equal(a.lineas[0].mensaje, "sentry_no_inicia");
        const b = log();
        assert.equal(
            await iniciarSentry({
                env: { SENTRY_DSN: DSN },
                importar: async () => sdkDoble({ falla: { init: true } }).sdk,
                log: b.log,
            }),
            false,
        );
        assert.equal(sentryActivo(), false, "un init fallido no deja el SDK a medias");
    });

    it("un DSN que el SDK no acepta (init no lanza, pero queda deshabilitado) no cuenta como activo y queda registrado", async () => {
        const { sdk } = sdkDoble({ falla: { deshabilitado: true } });
        const l = log();
        assert.equal(
            await iniciarSentry({
                env: { SENTRY_DSN: "esto-no-es-un-dsn" },
                importar: async () => sdk,
                log: l.log,
            }),
            false,
        );
        assert.equal(sentryActivo(), false);
        assert.equal(l.lineas[0].mensaje, "sentry_no_inicia");
        assert.match(l.lineas[0].error, /SENTRY_DSN/);
        assert.equal(
            l.lineas.some((x) => x.mensaje === "sentry_activo"),
            false,
        );
    });

    it("capturarError envía el error con etiquetas acotadas, omite las vacías y convierte lo que no es Error", async () => {
        const { sdk, llamadas } = sdkDoble();
        await iniciarSentry({
            env: { SENTRY_DSN: DSN },
            importar: async () => sdk,
            log: log().log,
        });
        const e = new Error("boom");
        capturarError(e, {
            tipo: "unhandled_error",
            requestId: "r".repeat(300),
            vacio: null,
            nada: undefined,
            empresa_id: 7,
        });
        assert.equal(llamadas.capturas[0], e);
        const tags = Object.fromEntries(llamadas.tags);
        assert.equal(tags.tipo, "unhandled_error");
        assert.equal(tags.requestId.length, 100);
        assert.equal(tags.empresa_id, "7");
        assert.equal("vacio" in tags || "nada" in tags, false);
        capturarError("texto suelto", {});
        assert.ok(llamadas.capturas[1] instanceof Error);
        assert.equal(llamadas.capturas[1].message, "texto suelto");
    });

    it("si el SDK falla al capturar o al vaciar, no se propaga", async () => {
        const { sdk } = sdkDoble({ falla: { withScope: true, flush: true } });
        await iniciarSentry({
            env: { SENTRY_DSN: DSN },
            importar: async () => sdk,
            log: log().log,
        });
        const salida = [];
        mock.method(console, "log", (l) => salida.push(l));
        assert.doesNotThrow(() => capturarError(new Error("x")));
        assert.equal(await vaciarSentry(10), false);
        mock.restoreAll();
        assert.match(salida.join(""), /sentry_captura_fallida/);
    });

    it("vaciarSentry espera como mucho el tope que se le da", async () => {
        const { sdk, llamadas } = sdkDoble();
        await iniciarSentry({
            env: { SENTRY_DSN: DSN },
            importar: async () => sdk,
            log: log().log,
        });
        assert.equal(await vaciarSentry(1234), true);
        assert.deepEqual(llamadas.flush, [1234]);
    });
});

describe("limpiarEvento (lo último antes de salir del servidor)", () => {
    it("quita petición, usuario y breadcrumbs; sanea mensaje, excepciones, etiquetas, extra y contextos", () => {
        const original = {
            message: "falló para ana@correo.com",
            request: {
                url: "https://x/api?token=abc",
                headers: { cookie: "gh_session=zzz" },
                data: { password: "p" },
            },
            user: { id: 1, email: "ana@correo.com", ip_address: "1.2.3.4" },
            breadcrumbs: [{ message: "GET /api con Bearer abc.def" }],
            server_name: "Carloss-MacBook-Air.local",
            exception: {
                values: [{ type: "Error", value: "no conecta a postgres://gh_app:clave@host/db" }],
            },
            tags: { tipo: "x", token: "abc" },
            extra: { password: "NoDebeVerse1", nota: "escribió a bea@x.mx" },
            contexts: { runtime: { name: "node" }, cookie: "gh_session=zzz" },
        };
        const antes = JSON.stringify(original);
        const l = limpiarEvento(original, "/app");
        const texto = JSON.stringify(l);
        for (const secreto of [
            "ana@correo.com",
            "abc.def",
            "clave@host",
            "NoDebeVerse1",
            "gh_session=zzz",
            "bea@x.mx",
            "Carloss",
        ])
            assert.equal(texto.includes(secreto), false, `quedó «${secreto}»`);
        assert.equal("request" in l || "user" in l || "breadcrumbs" in l, false);
        assert.equal(l.server_name, "api");
        assert.equal(l.tags.tipo, "x");
        assert.equal(l.tags.token, "[redactado]");
        assert.equal(l.extra.password, "[redactado]");
        assert.equal(l.contexts.runtime.name, "node");
        assert.equal(JSON.stringify(original), antes, "no modifica el original");
    });

    it("las rutas del stack quedan relativas al proyecto; las de fuera se dejan como están", () => {
        const l = limpiarEvento(
            {
                exception: {
                    values: [
                        {
                            value: "x",
                            stacktrace: {
                                frames: [
                                    { filename: "/app/src/middlewares/auth.js", lineno: 3 },
                                    { filename: "node:internal/process/task_queues", lineno: 1 },
                                    { filename: "/otro/lugar/modulo.js" },
                                    { lineno: 9 },
                                ],
                            },
                        },
                    ],
                },
            },
            "/app",
        );
        const f = l.exception.values[0].stacktrace.frames;
        assert.equal(f[0].filename, "src/middlewares/auth.js");
        assert.equal(f[1].filename, "node:internal/process/task_queues");
        assert.equal(f[2].filename, "/otro/lugar/modulo.js");
        assert.equal(f[3].filename, undefined);
    });

    it("un evento sin nada de esto pasa sin romperse", () => {
        assert.deepEqual(limpiarEvento({ level: "error" }), { level: "error" });
        assert.doesNotThrow(() => limpiarEvento({ exception: { values: [{}] } }));
    });
});

describe("integración con el resto del servidor", () => {
    afterEach(() => {
        reiniciarSentryParaPruebas();
        mock.restoreAll();
    });
    const res = () => ({
        status() {
            return this;
        },
        json() {},
    });

    it("un 500 inesperado va a Sentry con su requestId; un error controlado (4xx) no", async () => {
        const { sdk, llamadas } = sdkDoble();
        await iniciarSentry({
            env: { SENTRY_DSN: DSN },
            importar: async () => sdk,
            log: log().log,
        });
        mock.method(console, "error", () => {});
        errorHandler(
            new Error("inesperado"),
            { id: "req-12345678", user: { empresa_id: 9 } },
            res(),
            () => {},
        );
        assert.equal(llamadas.capturas.length, 1);
        const tags = Object.fromEntries(llamadas.tags);
        assert.equal(tags.requestId, "req-12345678");
        assert.equal(tags.tipo, "unhandled_error");
        assert.equal(tags.empresa_id, "9");
        errorHandler(ApiError.badRequest("mal"), { id: "r-123456789" }, res(), () => {});
        errorHandler(
            ApiError.forbidden("no").conEvento("permiso_denegado"),
            { id: "r-123456789" },
            res(),
            () => {},
        );
        assert.equal(llamadas.capturas.length, 1, "los errores controlados no van a Sentry");
    });

    it("un fallo fatal se reporta ANTES de cerrar, y si reportar lanza el cierre sigue", async () => {
        const orden = [];
        const salidas = [];
        const { fatal } = crearManejadoresFatales({
            cerrar: async () => orden.push("cerrar"),
            reportar: (tipo, error) => orden.push(`reportar:${tipo}:${error.message}`),
            salir: (c) => salidas.push(c),
            plazoMs: 50,
            log: { info() {}, warn() {}, error() {} },
        });
        fatal("unhandled_rejection", new Error("x"));
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(orden, ["reportar:unhandled_rejection:x", "cerrar"]);
        assert.deepEqual(salidas, [1]);

        const salidas2 = [];
        const m = crearManejadoresFatales({
            cerrar: async () => {},
            reportar: () => {
                throw new Error("Sentry se cayó");
            },
            salir: (c) => salidas2.push(c),
            plazoMs: 50,
            log: { info() {}, warn() {}, error() {} },
        });
        assert.doesNotThrow(() => m.fatal("uncaught_exception", new Error("y")));
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(salidas2, [1]);
    });
});

describe("con el SDK real contra un servidor local", () => {
    afterEach(() => reiniciarSentryParaPruebas());

    it("el envelope que sale no lleva correos, tokens ni credenciales, ni petición, usuario o nombre de máquina", async () => {
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
        try {
            const dsn = `http://clavePublica@127.0.0.1:${srv.address().port}/1`;
            assert.equal(
                await iniciarSentry({ env: { SENTRY_DSN: dsn, NODE_ENV: "test" }, log: log().log }),
                true,
            );
            capturarError(
                new Error(
                    "falló para ana@correo.com con Bearer abc.def en postgres://gh_app:clave@host/db",
                ),
                {
                    tipo: "unhandled_error",
                    requestId: "req-12345678",
                },
            );
            assert.equal(await vaciarSentry(5000), true);
            assert.equal(recibidos.length, 1, "un evento");
            const cuerpo = recibidos[0];
            for (const secreto of ["ana@correo.com", "abc.def", "gh_app:clave"])
                assert.equal(cuerpo.includes(secreto), false, `salió «${secreto}»`);
            assert.match(cuerpo, /a\*\*\*@correo\.com/);
            assert.match(cuerpo, /"requestId":"req-12345678"/);
            const evento = JSON.parse(cuerpo.split("\n")[2]);
            assert.equal(evento.server_name, "api");
            assert.equal("request" in evento, false);
            assert.equal("user" in evento, false);
            assert.equal(evento.breadcrumbs, undefined);
            assert.equal(evento.sdk.integrations.includes("Console"), false);
        } finally {
            await new Promise((r) => srv.close(r));
        }
    });
});
