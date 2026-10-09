import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTOS, registrarEvento, correoParaLog } from "../src/utils/seguridad.js";
import ApiError from "../src/utils/ApiError.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { crearLimite } from "../src/middlewares/limites.js";
import { iniciarServidor } from "./helpers/servidor.js";

// Eventos de seguridad: catálogo estable, forma de la línea, marca en ApiError y límite de tasa. Sin base de datos.

function capturar() {
    const lineas = [];
    const f = (l) => {
        try {
            lineas.push(JSON.parse(l));
        } catch {
            /* no es una línea de log JSON (p. ej. un aviso de una librería) */
        }
    };
    mock.method(console, "log", f);
    mock.method(console, "error", f);
    return lineas;
}

const archivos = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) return archivos(ruta);
        return e.name.endsWith(".js") ? [ruta] : [];
    });

describe("catálogo de eventos", () => {
    it("los nombres son estables: minúsculas con guion bajo, con descripción, y el catálogo no se puede alterar", () => {
        for (const [nombre, descripcion] of Object.entries(EVENTOS)) {
            assert.match(nombre, /^[a-z]+(_[a-z]+)*$/, nombre);
            assert.ok(descripcion.length > 10, `${nombre} sin descripción`);
        }
        assert.equal(Object.isFrozen(EVENTOS), true);
    });

    it("todo evento usado en el código existe en el catálogo, y todo evento del catálogo se usa en algún sitio", () => {
        const fuente = archivos("src")
            .filter((f) => !f.endsWith("seguridad.js"))
            .map((f) => readFileSync(f, "utf8"))
            .join("\n");
        const usados = new Set();
        for (const m of fuente.matchAll(/conEvento\(\s*"([a-z_]+)"/g)) usados.add(m[1]);
        for (const m of fuente.matchAll(/registrarEvento\(\s*req,\s*"([a-z_]+)"/g))
            usados.add(m[1]);
        const desconocidos = [...usados].filter((n) => !(n in EVENTOS));
        assert.deepEqual(desconocidos, [], `eventos sin declarar en EVENTOS: ${desconocidos}`);
        const sinUso = Object.keys(EVENTOS).filter((n) => !usados.has(n));
        assert.deepEqual(sinUso, [], `eventos declarados que nadie emite: ${sinUso}`);
    });
});

describe("registrarEvento", () => {
    afterEach(() => mock.restoreAll());

    it("escribe una línea security con id de petición, ip, usuario y empresa", () => {
        const lineas = capturar();
        registrarEvento(
            { id: "req-12345678", ip: "203.0.113.9", user: { id: 4, empresa_id: 12 } },
            "permiso_denegado",
            { requiere: "admin" },
        );
        const l = lineas[0];
        assert.equal(l.message, "security");
        assert.equal(l.level, "warn");
        assert.equal(l.evento, "permiso_denegado");
        assert.equal(l.requestId, "req-12345678");
        assert.equal(l.ip, "203.0.113.9");
        assert.equal(l.usuario_id, 4);
        assert.equal(l.empresa_id, 12);
        assert.equal(l.requiere, "admin");
    });

    it("los datos pisan el contexto (quien intenta entrar aún no tiene sesión) y el nivel se puede bajar a info", () => {
        const lineas = capturar();
        registrarEvento({ id: "r-12345678", ip: "1.1.1.1" }, "login_fallido", { usuario_id: 77 });
        registrarEvento(
            { id: "r-12345678", ip: "1.1.1.1" },
            "acceso_compartido_concedido",
            {},
            "info",
        );
        assert.equal(lineas[0].usuario_id, 77);
        assert.equal(lineas[1].level, "info");
    });

    it("un campo secreto que se cuele en los datos sale tapado", () => {
        const lineas = capturar();
        registrarEvento({ id: "r-12345678" }, "login_fallido", {
            password: "NoDebeVerse1",
            pin: "7391",
        });
        assert.equal(lineas[0].password, "[redactado]");
        assert.equal(lineas[0].pin, "[redactado]");
    });
});

describe("correoParaLog", () => {
    it("enmascara un correo y no registra lo que no lo parece (una contraseña pegada en el campo equivocado)", () => {
        assert.equal(correoParaLog("Ana@Correo.com "), "A***@Correo.com");
        for (const raro of [
            "MiClaveSecreta123",
            "con espacios@x.com",
            "",
            null,
            undefined,
            42,
            "a@b",
        ])
            assert.equal(correoParaLog(raro), "[no es un correo]", String(raro));
        assert.equal(correoParaLog("x".repeat(500) + "@y.com"), "[no es un correo]");
    });
});

describe("ApiError.conEvento y el manejador de errores", () => {
    afterEach(() => mock.restoreAll());
    const res = () => ({
        status(c) {
            this.codigo = c;
            return this;
        },
        json(b) {
            this.cuerpo = b;
        },
    });

    it("un error con evento deja la línea security (con el status) y la respuesta no cambia", () => {
        const lineas = capturar();
        const r = res();
        const err = ApiError.forbidden("No tienes acceso").conEvento("empresa_ajena", {
            empresa_solicitada: "9",
        });
        errorHandler(
            err,
            { id: "req-12345678", ip: "9.9.9.9", user: { id: 1, empresa_id: 2 } },
            r,
            () => {},
        );
        assert.equal(r.codigo, 403);
        assert.deepEqual(r.cuerpo, { success: false, error: "No tienes acceso" });
        const l = lineas.find((x) => x.message === "security");
        assert.equal(l.evento, "empresa_ajena");
        assert.equal(l.status, 403);
        assert.equal(l.empresa_solicitada, "9");
        assert.equal(l.ip, "9.9.9.9");
    });

    it("un error sin evento no escribe línea security", () => {
        const lineas = capturar();
        errorHandler(ApiError.badRequest("mal"), { id: "r-12345678" }, res(), () => {});
        assert.equal(lineas.filter((x) => x.message === "security").length, 0);
    });

    it("conEvento devuelve el mismo error (se puede encadenar con throw) y no altera status ni mensaje", () => {
        const e = ApiError.unauthorized("x");
        assert.equal(e.conEvento("token_invalido"), e);
        assert.equal(e.statusCode, 401);
        assert.equal(e.message, "x");
    });
});

describe("crearLimite", () => {
    afterEach(() => mock.restoreAll());

    async function servidor(opciones) {
        const app = express();
        app.set("trust proxy", 1);
        app.use((req, _res, next) => {
            req.id = "req-limite-1234";
            next();
        });
        app.use("/acceso", crearLimite(opciones), (_req, res) => res.json({ ok: true }));
        return await iniciarServidor(app);
    }
    const desde = (base, ip) =>
        fetch(`${base}/acceso/login?x=1`, { headers: { "X-Forwarded-For": ip } });

    it("pasado el tope responde 429 con el cuerpo de siempre y deja UN evento por IP y ventana", async () => {
        const { server, base } = await servidor({
            nombre: "auth",
            max: 2,
            error: "Demasiados intentos.",
        });
        try {
            const lineas = capturar();
            const estados = [];
            for (let i = 0; i < 5; i++) estados.push((await desde(base, "198.51.100.1")).status);
            assert.deepEqual(estados, [200, 200, 429, 429, 429]);
            const r = await desde(base, "198.51.100.1");
            assert.deepEqual(await r.json(), { success: false, error: "Demasiados intentos." });
            assert.ok(
                r.headers.get("ratelimit") || r.headers.get("ratelimit-limit"),
                "cabeceras estándar de límite",
            );
            const eventos = lineas.filter((l) => l.evento === "limite_excedido");
            assert.equal(eventos.length, 1, "un solo evento aunque sigan los intentos");
            assert.equal(eventos[0].limite, "auth");
            assert.equal(eventos[0].max, 2);
            assert.equal(eventos[0].ruta, "/acceso/login");
            assert.equal(eventos[0].status, 429);
            assert.equal(eventos[0].ip, "198.51.100.1");
            assert.equal(JSON.stringify(eventos[0]).includes("x=1"), false, "sin la query");
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("otra IP que se pasa del tope genera su propio evento", async () => {
        const { server, base } = await servidor({ nombre: "pin", max: 1, error: "x" });
        try {
            const lineas = capturar();
            for (const ip of ["203.0.113.1", "203.0.113.2"]) {
                await desde(base, ip);
                await desde(base, ip);
            }
            const ips = lineas.filter((l) => l.evento === "limite_excedido").map((l) => l.ip);
            assert.deepEqual(ips.sort(), ["203.0.113.1", "203.0.113.2"]);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("`skip` exime a las peticiones que no son tráfico de uso", async () => {
        const { server, base } = await servidor({
            nombre: "api",
            max: 1,
            error: "x",
            skip: (req) => req.query.x === "1",
        });
        try {
            capturar();
            for (let i = 0; i < 4; i++) assert.equal((await desde(base, "192.0.2.1")).status, 200);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});
