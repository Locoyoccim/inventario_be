import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import bcrypt from "bcryptjs";
import { iniciarServidor } from "../helpers/servidor.js";

// Estrategia de autenticación web (ver docs/architecture/AUTH_STRATEGY.md): JWT en cookie httpOnly, nunca en el body;
// Authorization: Bearer sigue aceptado por el middleware (integraciones futuras) pero ningún endpoint lo entrega.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — sesión web: cookie httpOnly sin token en el body", { skip: SKIP }, () => {
    const E = 9901;
    const MAIL = "sesion@auth-sesion.test";
    const CLAVE = "ClaveDePrueba123";
    let server, base, pool;

    const req = async (method, path, { cookie, bearer, body, headers = {} } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(cookie ? { cookie: `gh_session=${cookie}` } : {}),
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try { json = JSON.parse(texto); } catch { /* vacío */ }
        return { status: res.status, json, texto, headers: res.headers };
    };
    const ingresar = () => req("POST", "/api/auth/login", { body: { email: MAIL, password: CLAVE } });
    const jwtDe = (r) => decodeURIComponent(/gh_session=([^;]+)/.exec(r.headers.get("set-cookie"))[1]);
    const limpiar = async () => {
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Auth Sesion')", [E]);
        await pool.query(
            `INSERT INTO usuarios (nombre,codigo_ingreso,email,password_hash,is_admin,is_owner,must_change_password,empresa_id)
             VALUES ('Dueña','AS-own',$1,$2,true,true,false,$3)`,
            [MAIL, await bcrypt.hash(CLAVE, 4), E],
        );
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("el login responde 200 con la cookie httpOnly y SIN token en el body (ni el JWT en ninguna parte del texto)", async () => {
        const r = await ingresar();
        assert.equal(r.status, 200, r.texto);
        const cookie = r.headers.get("set-cookie");
        assert.match(cookie, /^gh_session=/);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.equal(r.json.data.token, undefined);
        assert.ok(r.json.data.user && r.json.data.user.email === MAIL, "el resto de la respuesta se conserva");
        assert.ok(!r.texto.includes(jwtDe(r)), "el JWT no debe aparecer en el cuerpo de la respuesta");
    });

    it("la cookie autentica lecturas; las escrituras con cookie exigen X-Requested-With (anti-CSRF)", async () => {
        const jwt = jwtDe(await ingresar());
        assert.equal((await req("GET", "/api/auth/me", { cookie: jwt })).status, 200);
        const cfg = { body: { zona_horaria: "America/Mexico_City" } };
        const sin = await req("PUT", `/api/empresas/${E}/configuracion`, { cookie: jwt, ...cfg });
        assert.equal(sin.status, 403, "con cookie y sin el header, la escritura se rechaza");
        const con = await req("PUT", `/api/empresas/${E}/configuracion`, { cookie: jwt, ...cfg, headers: { "X-Requested-With": "XMLHttpRequest" } });
        assert.equal(con.status, 200, con.texto);
    });

    it("Authorization: Bearer sigue aceptado (integraciones futuras) y no depende de la cookie ni del header anti-CSRF", async () => {
        const jwt = jwtDe(await ingresar());
        assert.equal((await req("GET", "/api/auth/me", { bearer: jwt })).status, 200);
        const w = await req("PUT", `/api/empresas/${E}/configuracion`, { bearer: jwt, body: { zona_horaria: "America/Mexico_City" } });
        assert.equal(w.status, 200, w.texto);
    });

    it("sin credenciales o con un token inválido: 401", async () => {
        assert.equal((await req("GET", "/api/auth/me")).status, 401);
        assert.equal((await req("GET", "/api/auth/me", { cookie: "no.es.un.jwt" })).status, 401);
        assert.equal((await req("GET", "/api/auth/me", { bearer: "no.es.un.jwt" })).status, 401);
    });

    it("cerrar todas las sesiones revoca el JWT tanto por cookie como por Bearer", async () => {
        const jwt = jwtDe(await ingresar());
        const salir = await req("POST", "/api/auth/logout-all", { cookie: jwt, headers: { "X-Requested-With": "XMLHttpRequest" } });
        assert.equal(salir.status, 200, salir.texto);
        assert.equal((await req("GET", "/api/auth/me", { cookie: jwt })).status, 401);
        assert.equal((await req("GET", "/api/auth/me", { bearer: jwt })).status, 401);
    });

    it("el script de Postman del login (docs/postman_collection.json) obtiene un token que sirve como Bearer con la API real", async () => {
        const coleccion = JSON.parse(readFileSync("docs/postman_collection.json", "utf8"));
        const login = coleccion.item.find((i) => i.name === "Auth").item.find((i) => i.name === "Login");
        const script = login.event.find((e) => e.listen === "test").script.exec.join("\n");
        const r = await ingresar();
        const variables = new Map();
        const pruebas = [];
        const pm = {
            response: { json: () => r.json, headers: { get: (n) => r.headers.get(n) } },
            collectionVariables: { set: (k, v) => variables.set(k, v), get: (k) => variables.get(k) },
            test: (nombre, fn) => { fn(); pruebas.push(nombre); },
        };
        runInNewContext(script, { pm, decodeURIComponent, String });
        assert.equal(pruebas.length, 1, "la prueba de Postman debe pasar");
        assert.equal(variables.get("empresa_id"), String(E));
        assert.equal(variables.get("token"), jwtDe(r));
        assert.equal((await req("GET", "/api/auth/me", { bearer: variables.get("token") })).status, 200);
    });

    it("sin cookie en la respuesta, la prueba de Postman falla con un mensaje claro (no deja una colección «verde» sin sesión)", () => {
        const coleccion = JSON.parse(readFileSync("docs/postman_collection.json", "utf8"));
        const script = coleccion.item.find((i) => i.name === "Auth").item.find((i) => i.name === "Login").event.find((e) => e.listen === "test").script.exec.join("\n");
        const variables = new Map();
        const pm = {
            response: { json: () => ({ success: true, data: { user: { empresa_id: 1 } } }), headers: { get: () => null } },
            collectionVariables: { set: (k, v) => variables.set(k, v), get: (k) => variables.get(k) },
            test: (_n, fn) => fn(),
        };
        assert.throws(() => runInNewContext(script, { pm, decodeURIComponent, String }), /no devolvio la cookie gh_session/);
    });
});
