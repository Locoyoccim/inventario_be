import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Ingreso con PIN en equipos registrados: registro del equipo con código de un solo uso, PIN, bloqueos y límites de Admin.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — PIN y equipos registrados", { skip: SKIP }, () => {
    const A = 9761;
    const B = 9762;
    let server, base, pool, signToken, verifyToken;
    let tokAdmin, tokAdminB, adminId, meseroId, cajeroId, otroId, ajenoId;
    const PIN = "4827";

    const req = async (method, path, { token = tokAdmin, cookie, body, csrf = true } = {}) => {
        const headers = {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(csrf ? { "X-Requested-With": "XMLHttpRequest" } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        };
        const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json, cookies: res.headers.getSetCookie() };
    };
    const valorCookie = (cookies, nombre) => cookies.find((c) => c.startsWith(`${nombre}=`))?.split(";")[0];

    const limpiar = async () => {
        const e = [[A, B]];
        await pool.query("DELETE FROM pin_fallos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM dispositivos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };
    const mkUsuario = async (empresa, codigo, { admin = false, rol = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        return (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id", [codigo, admin, empresa, rolId])).rows[0].id;
    };
    // Registra un equipo completo y devuelve su cookie lista para usarse.
    const equipo = async (nombre = "Celular") => {
        const c = await req("POST", `/api/dispositivos/${A}`, { body: { nombre } });
        assert.equal(c.status, 201, JSON.stringify(c.json));
        const canje = await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: c.json.data.codigo } });
        assert.equal(canje.status, 200, JSON.stringify(canje.json));
        return { id: c.json.data.dispositivo.id, cookie: valorCookie(canje.cookies, "gh_device") };
    };
    const entrar = (cookie, usuario_id, pin, extra = {}) => req("POST", "/api/auth/pin", { token: null, cookie, body: { usuario_id, pin }, ...extra });
    // Hace que los fallos «ya tengan» minutos de antigüedad para simular el paso del tiempo.
    const envejecerFallos = (minutos) => pool.query("UPDATE pin_fallos SET created_at = created_at - make_interval(mins => $1) WHERE empresa_id = $2", [minutos, A]);

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken, verifyToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Con PIN'), ($2,'Otra')", [A, B]);
        adminId = await mkUsuario(A, "PN-adm", { admin: true });
        tokAdmin = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        const adminBId = await mkUsuario(B, "PN-admB", { admin: true });
        tokAdminB = signToken({ id: adminBId, empresa_id: B, is_admin: true, is_owner: true, tv: 0 });
        meseroId = await mkUsuario(A, "PN-mes", { rol: "mesero" });
        cajeroId = await mkUsuario(A, "PN-caj", { rol: "mesero" });
        otroId = await mkUsuario(A, "PN-sin", { rol: "mesero" }); // sin PIN
        ajenoId = await mkUsuario(B, "PN-ajeno", { rol: "mesero" });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("el PIN lo define un Admin, se rechazan los triviales y a los administradores", async () => {
        for (const pin of ["1234", "0000", "12", "1234567", "12ab"]) {
            const r = await req("PUT", `/api/usuarios/${A}/${meseroId}/pin`, { body: { pin } });
            assert.equal(r.status, 400, `${pin}: ${JSON.stringify(r.json)}`);
        }
        assert.equal((await req("PUT", `/api/usuarios/${A}/${adminId}/pin`, { body: { pin: PIN } })).status, 400, "un administrador no usa PIN");
        assert.equal((await req("PUT", `/api/usuarios/${A}/${meseroId}/pin`, { body: { pin: PIN } })).status, 200);
        assert.equal((await req("PUT", `/api/usuarios/${A}/${cajeroId}/pin`, { body: { pin: PIN } })).status, 200);
        const h = (await pool.query("SELECT id, pin_hash FROM usuarios WHERE id = ANY($1)", [[meseroId, cajeroId]])).rows;
        assert.ok(h.every((x) => x.pin_hash.startsWith("$2") && !x.pin_hash.includes(PIN)), "el PIN no se guarda en claro");
        assert.notEqual(h[0].pin_hash, h[1].pin_hash, "mismo PIN, hash distinto por usuario");
        const lista = (await req("GET", `/api/usuarios/${A}`)).json.data;
        assert.equal(lista.find((u) => u.id === meseroId).tiene_pin, true);
        assert.equal(lista.find((u) => u.id === otroId).tiene_pin, false);
        assert.equal(lista.find((u) => u.id === meseroId).pin_hash, undefined, "el hash nunca sale en la API");
    });

    it("un operativo no administra equipos ni PIN", async () => {
        const tokMesero = signToken({ id: meseroId, empresa_id: A, is_admin: false, tv: 0 });
        assert.equal((await req("GET", `/api/dispositivos/${A}`, { token: tokMesero })).status, 403);
        assert.equal((await req("PUT", `/api/usuarios/${A}/${meseroId}/pin`, { token: tokMesero, body: { pin: "9631" } })).status, 403);
    });

    it("el equipo se registra con un código de un solo uso que vence", async () => {
        const c = await req("POST", `/api/dispositivos/${A}`, { body: { nombre: "Celular Ana" } });
        assert.equal(c.status, 201);
        assert.match(c.json.data.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        assert.equal(c.json.data.dispositivo.estado, "PENDIENTE");
        const enBd = (await pool.query("SELECT codigo_hash FROM dispositivos WHERE id = $1", [c.json.data.dispositivo.id])).rows[0];
        assert.ok(enBd.codigo_hash && !enBd.codigo_hash.includes(c.json.data.codigo), "solo queda el hash del código");

        const mal = await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: "ZZZZ-ZZZZ" } });
        assert.equal(mal.status, 400);
        assert.equal((await req("POST", "/api/auth/dispositivo/registrar", { token: null, csrf: false, body: { codigo: c.json.data.codigo } })).status, 403, "sin cabecera anti-CSRF");

        const ok = await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: c.json.data.codigo.toLowerCase() } });
        assert.equal(ok.status, 200, JSON.stringify(ok.json));
        assert.equal(ok.json.data.nombre, "Celular Ana");
        const cookie = ok.cookies.find((x) => x.startsWith("gh_device="));
        assert.ok(cookie, "entrega la cookie del equipo");
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /Path=\/api\/auth/i, "la cookie del equipo solo viaja a /api/auth");

        const otra = await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: c.json.data.codigo } });
        assert.equal(otra.status, 400, "el código se consume al usarlo");

        const venc = await req("POST", `/api/dispositivos/${A}`, { body: { nombre: "Vencido" } });
        await pool.query("UPDATE dispositivos SET codigo_expira_at = now() - interval '1 minute' WHERE id = $1", [venc.json.data.dispositivo.id]);
        assert.equal((await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: venc.json.data.codigo } })).status, 400, "código vencido");
        const lista = (await req("GET", `/api/dispositivos/${A}`)).json.data;
        assert.equal(lista.find((d) => d.nombre === "Vencido").estado, "CODIGO_VENCIDO");
        assert.equal(lista.find((d) => d.nombre === "Celular Ana").estado, "ACTIVO");
        assert.ok(lista.every((d) => d.token_hash === undefined && d.codigo_hash === undefined), "no salen hashes");
    });

    it("la lista de personal es solo del equipo y solo trae gente con PIN que no es administradora", async () => {
        const e = await equipo();
        assert.equal((await req("GET", "/api/auth/dispositivo/personal", { token: null })).status, 401, "sin equipo registrado");
        const r = await req("GET", "/api/auth/dispositivo/personal", { token: null, cookie: e.cookie });
        assert.equal(r.status, 200);
        const nombres = r.json.data.personal.map((p) => p.nombre);
        assert.deepEqual(nombres.sort(), ["PN-caj", "PN-mes"]);
        assert.ok(!nombres.includes("PN-adm") && !nombres.includes("PN-sin") && !nombres.includes("PN-ajeno"));
    });

    it("entra con PIN: sesión de turno, sin acceso a Admin, y el equipo es obligatorio", async () => {
        const e = await equipo();
        assert.equal((await entrar(null, meseroId, PIN)).status, 401, "sin cookie del equipo");
        assert.equal((await entrar(e.cookie, meseroId, PIN, { csrf: false })).status, 403, "sin cabecera anti-CSRF");
        const r = await entrar(e.cookie, meseroId, PIN);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.user.is_admin, false);
        assert.equal(r.json.data.token, undefined, "el token solo viaja en la cookie httpOnly");
        const sesion = r.cookies.find((x) => x.startsWith("gh_session="));
        assert.match(sesion, /HttpOnly/i);
        assert.match(sesion, /Max-Age=43200/, "sesión de turno (12 h), no de 7 días");
        const jwt = verifyToken(decodeURIComponent(sesion.split(";")[0].split("=")[1]));
        assert.equal(jwt.pin, true);
        assert.equal(jwt.disp, e.id);

        // Con esa sesión: opera lo suyo, no lo de Admin.
        const cookie = valorCookie(r.cookies, "gh_session");
        const yo = await req("GET", "/api/auth/me", { token: null, cookie });
        assert.equal(yo.status, 200, JSON.stringify(yo.json));
        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: null, cookie })).status, 200);
        assert.equal((await req("GET", `/api/dispositivos/${A}`, { token: null, cookie })).status, 403, "sesión de PIN fuera de rutas de Admin");
        assert.equal((await req("PUT", `/api/empresas/${A}/configuracion`, { token: null, cookie, body: { usa_pantalla_cocina: true } })).status, 403);
        assert.equal((await pool.query("SELECT ultimo_uso FROM dispositivos WHERE id = $1", [e.id])).rows[0].ultimo_uso !== null, true);
    });

    it("PIN incorrecto, administradores, sin PIN y otra empresa responden igual", async () => {
        const e = await equipo();
        const base1 = await entrar(e.cookie, meseroId, "9631");
        assert.equal(base1.status, 401);
        for (const id of [adminId, otroId, ajenoId, 99999999]) {
            const r = await entrar(e.cookie, id, PIN);
            assert.equal(r.status, 401, `usuario ${id}`);
            assert.equal(r.json.error, base1.json.error);
        }
        // Un administrador al que alguien le puso PIN directo en la base tampoco entra.
        await pool.query("UPDATE usuarios SET pin_hash = (SELECT pin_hash FROM usuarios WHERE id = $2) WHERE id = $1", [adminId, meseroId]);
        assert.equal((await entrar(e.cookie, adminId, PIN)).status, 401);
        await pool.query("UPDATE usuarios SET pin_hash = NULL WHERE id = $1", [adminId]);
        await pool.query("DELETE FROM pin_fallos WHERE empresa_id = $1", [A]);
    });

    it("5 fallos enfrían 5 min (aun con el PIN bueno), y 10 bloquean hasta que un Admin lo quite", async () => {
        const e = await equipo();
        await pool.query("DELETE FROM pin_fallos WHERE empresa_id = $1", [A]);
        for (let i = 0; i < 5; i++) assert.equal((await entrar(e.cookie, cajeroId, "9631")).status, 401);
        const frio = await entrar(e.cookie, cajeroId, PIN);
        assert.equal(frio.status, 429, "enfriamiento aunque el PIN sea el bueno");
        assert.ok(frio.json.details.espera_seg > 0 && frio.json.details.espera_seg <= 300);
        // Otro usuario en el MISMO equipo no queda bloqueado por los fallos del cajero.
        assert.equal((await entrar(e.cookie, meseroId, PIN)).status, 200);

        // Pasan 6 minutos y se puede intentar otra vez; cada fallo nuevo vuelve a enfriar, así que se acumulan hasta el bloqueo duro.
        for (let i = 0; i < 5; i++) {
            await envejecerFallos(6);
            assert.equal((await entrar(e.cookie, cajeroId, "9631")).status, 401, `fallo ${i + 6}`);
        }
        assert.ok((await pool.query("SELECT pin_bloqueado_at FROM usuarios WHERE id = $1", [cajeroId])).rows[0].pin_bloqueado_at, "10 fallos en una hora bloquean el PIN");
        await envejecerFallos(6);
        const duro = await entrar(e.cookie, cajeroId, PIN);
        assert.equal(duro.status, 429);
        assert.equal(duro.json.details.bloqueado, true);

        // Solo un Admin lo desbloquea; el operativo no puede.
        const tokCajero = signToken({ id: cajeroId, empresa_id: A, is_admin: false, tv: 0 });
        assert.equal((await req("POST", `/api/usuarios/${A}/${cajeroId}/pin/desbloquear`, { token: tokCajero })).status, 403);
        assert.equal((await req("POST", `/api/usuarios/${A}/${cajeroId}/pin/desbloquear`)).status, 200);
        assert.equal((await entrar(e.cookie, cajeroId, PIN)).status, 200);
    });

    it("el enfriamiento por equipo frena a quien prueba usuarios distintos desde el mismo equipo", async () => {
        const e = await equipo();
        await pool.query("DELETE FROM pin_fallos WHERE empresa_id = $1", [A]);
        // 15 fallos repartidos entre 5 usuarios (3 c/u: ninguno llega a su propio enfriamiento de 5, pero el equipo suma 15).
        const gente = [meseroId, cajeroId, otroId, adminId, ajenoId];
        for (const u of gente) {
            for (let i = 0; i < 3; i++) await pool.query("INSERT INTO pin_fallos (empresa_id, usuario_id, dispositivo_id) VALUES ($1,$2,$3)", [A, u, e.id]);
        }
        const r = await entrar(e.cookie, meseroId, PIN);
        assert.equal(r.status, 429, "el equipo entero queda en enfriamiento");
        assert.ok(r.json.details.espera_seg > 0);
        // Otro equipo no se ve afectado por los fallos de este.
        const otro = await equipo("Otro celular");
        assert.equal((await entrar(otro.cookie, meseroId, PIN)).status, 200);
        await pool.query("DELETE FROM pin_fallos WHERE empresa_id = $1", [A]);
    });

    it("un equipo revocado deja sin acceso a sus sesiones y a la lista de personal", async () => {
        const e = await equipo("Para revocar");
        const r = await entrar(e.cookie, meseroId, PIN);
        assert.equal(r.status, 200);
        const cookie = valorCookie(r.cookies, "gh_session");
        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: null, cookie })).status, 200);

        assert.equal((await req("POST", `/api/dispositivos/${A}/${e.id}/revocar`, { token: tokAdminB })).status, 403, "otra empresa no revoca equipos ajenos");
        const rev = await req("POST", `/api/dispositivos/${A}/${e.id}/revocar`);
        assert.equal(rev.status, 200);
        assert.equal(rev.json.data.estado, "REVOCADO");

        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: null, cookie })).status, 401, "la sesión de PIN deja de valer");
        const pers = await req("GET", "/api/auth/dispositivo/personal", { token: null, cookie: e.cookie });
        assert.equal(pers.status, 401);
        assert.ok(pers.cookies.some((c) => c.startsWith("gh_device=") && /Expires=Thu, 01 Jan 1970/i.test(c)), "borra la cookie del equipo revocado");
        assert.equal((await entrar(e.cookie, meseroId, PIN)).status, 401);
        // No se borra: sigue en la lista como revocado.
        assert.equal((await req("GET", `/api/dispositivos/${A}`)).json.data.find((d) => d.id === e.id).estado, "REVOCADO");
    });

    it("un código nuevo vuelve a registrar el equipo y el token anterior deja de servir", async () => {
        const e = await equipo("Cambio de celular");
        const nuevo = await req("POST", `/api/dispositivos/${A}/${e.id}/codigo`);
        assert.equal(nuevo.status, 200);
        const canje = await req("POST", "/api/auth/dispositivo/registrar", { token: null, body: { codigo: nuevo.json.data.codigo } });
        assert.equal(canje.status, 200);
        const cookieNueva = valorCookie(canje.cookies, "gh_device");
        assert.notEqual(cookieNueva, e.cookie);
        assert.equal((await req("GET", "/api/auth/dispositivo/personal", { token: null, cookie: e.cookie })).status, 401, "el token anterior ya no vale");
        assert.equal((await req("GET", "/api/auth/dispositivo/personal", { token: null, cookie: cookieNueva })).status, 200);
    });

    it("aislamiento: el equipo de una empresa no inicia sesión con gente de otra", async () => {
        const e = await equipo();
        await pool.query("UPDATE usuarios SET pin_hash = (SELECT pin_hash FROM usuarios WHERE id = $2) WHERE id = $1", [ajenoId, meseroId]);
        assert.equal((await entrar(e.cookie, ajenoId, PIN)).status, 401);
        assert.equal((await req("GET", `/api/dispositivos/${A}`, { token: tokAdminB })).status, 403);
        assert.equal((await req("PUT", `/api/usuarios/${A}/${meseroId}/pin`, { token: tokAdminB, body: { pin: "9631" } })).status, 403);
        await pool.query("UPDATE usuarios SET pin_hash = NULL WHERE id = $1", [ajenoId]);
    });

    it("una sesión de PIN no sobrevive a un ascenso a Admin, a quitar el PIN ni a desactivar al usuario", async () => {
        const e = await equipo();
        const abrir = async (id) => valorCookie((await entrar(e.cookie, id, PIN)).cookies, "gh_session");

        // Ascenso: la sesión de PIN no hereda poderes de Admin; hay que volver a entrar con correo y contraseña.
        let cookie = await abrir(meseroId);
        assert.equal((await req("GET", "/api/auth/me", { token: null, cookie })).status, 200);
        await req("PUT", `/api/usuarios/${A}/${meseroId}`, { body: { nombre: "PN-mes", codigo_ingreso: "PN-mes", is_admin: true } });
        assert.equal((await req("GET", `/api/dispositivos/${A}`, { token: null, cookie })).status, 401);
        assert.equal((await entrar(e.cookie, meseroId, PIN)).status, 401, "ya no entra con PIN");
        await req("PUT", `/api/usuarios/${A}/${meseroId}`, { body: { nombre: "PN-mes", codigo_ingreso: "PN-mes", is_admin: false } });

        // Quitar el PIN cierra sus sesiones.
        cookie = await abrir(meseroId);
        assert.equal((await req("GET", "/api/auth/me", { token: null, cookie })).status, 200);
        assert.equal((await req("DELETE", `/api/usuarios/${A}/${meseroId}/pin`)).status, 200);
        assert.equal((await req("GET", "/api/auth/me", { token: null, cookie })).status, 401);
        assert.equal((await entrar(e.cookie, meseroId, PIN)).status, 401);
        assert.equal((await req("PUT", `/api/usuarios/${A}/${meseroId}/pin`, { body: { pin: PIN } })).status, 200);

        // Desactivar al usuario.
        cookie = await abrir(cajeroId);
        await req("PUT", `/api/usuarios/${A}/${cajeroId}`, { body: { nombre: "PN-caj", codigo_ingreso: "PN-caj", activo: false } });
        assert.equal((await req("GET", "/api/auth/me", { token: null, cookie })).status, 401);
        assert.equal((await entrar(e.cookie, cajeroId, PIN)).status, 401);
        await req("PUT", `/api/usuarios/${A}/${cajeroId}`, { body: { nombre: "PN-caj", codigo_ingreso: "PN-caj", activo: true } });
    });
});
