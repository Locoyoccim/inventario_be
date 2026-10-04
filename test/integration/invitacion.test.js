import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — invitación del owner por correo", { skip: SKIP }, () => {
    const PLAT = 9491; // empresa que aloja al usuario maestro de la prueba
    const MAIL = "owner.invitado@invitacion.test";
    let server, base, pool, signToken, correosDePrueba, tokPlat, empresaId;

    const req = async (method, path, { token, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const tokenDe = (url) => url.split("/invitacion/")[1];
    const ultimoCorreo = () => correosDePrueba.at(-1);
    const enlaceDe = (correo) => /https?:\/\/\S+\/invitacion\/[A-Za-z0-9_-]+/.exec(correo.text)[0];

    const limpiar = async () => {
        await pool.query("DELETE FROM categorias_gasto WHERE empresa_id IN (SELECT id FROM empresas WHERE nombre LIKE 'Invitada SA%')");
        await pool.query("DELETE FROM empresas WHERE nombre LIKE 'Invitada SA%'");
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [PLAT]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [PLAT]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ correosDePrueba } = await import("../../src/utils/mailer.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Plataforma prueba')", [PLAT]);
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,is_platform_admin,empresa_id) VALUES ('IV-plat','IV-plat',true,true,true,$1) RETURNING id", [PLAT],
        )).rows[0].id;
        tokPlat = signToken({ id, empresa_id: PLAT, is_admin: true, is_owner: true, is_platform_admin: true, tv: 0 });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("alta sin contraseña: el owner nace sin acceso, recibe un correo con enlace y la contraseña no se guarda en claro", async () => {
        const antes = correosDePrueba.length;
        const r = await req("POST", "/api/platform/empresas", {
            token: tokPlat,
            body: { empresa: { nombre: "Invitada SA" }, owner: { nombre: "Dueña Nueva", email: MAIL, codigo_ingreso: "OWN-INV" } },
        });
        assert.equal(r.status, 201, JSON.stringify(r.json));
        empresaId = r.json.data.empresa.id;
        assert.equal(r.json.data.invitacion.enviada, true);
        assert.equal(r.json.data.invitacion.url, undefined, "con correo enviado no se expone el enlace en la respuesta");
        assert.equal(correosDePrueba.length, antes + 1);
        const c = ultimoCorreo();
        assert.equal(c.to[0].address, MAIL);
        assert.match(c.subject, /Activa tu cuenta/);
        assert.match(c.html, /Definir mi contraseña/);
        assert.match(enlaceDe(c), /\/invitacion\//);

        const u = (await pool.query("SELECT password_hash FROM usuarios WHERE email = $1", [MAIL])).rows[0];
        assert.equal(u.password_hash, null);
        const t = (await pool.query("SELECT token_hash FROM usuario_tokens WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)", [MAIL])).rows;
        assert.equal(t.length, 1);
        assert.notEqual(t[0].token_hash.trim(), tokenDe(enlaceDe(c)), "en la base solo está el hash del token");
        // Sin contraseña no puede entrar, ni siquiera probando una vacía o una cualquiera.
        assert.equal((await req("POST", "/api/auth/login", { body: { email: MAIL, password: "cualquiera123" } })).status, 401);
        const lista = (await req("GET", "/api/platform/empresas", { token: tokPlat })).json.data.find((e) => e.id === empresaId);
        assert.equal(lista.owner_invitacion_pendiente, true);
    });

    it("la pantalla de activación consulta el enlace; uno inventado da 404 sin revelar nada", async () => {
        const token = tokenDe(enlaceDe(ultimoCorreo()));
        const ok = await req("GET", `/api/auth/invitacion/${token}`);
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.json.data, { nombre: "Dueña Nueva", email: MAIL, empresa: "Invitada SA" });
        assert.equal((await req("GET", "/api/auth/invitacion/inventado-inventado-inventado")).status, 404);
    });

    it("activar: exige mínimo 8 caracteres, define la contraseña, permite entrar y el enlace sirve una sola vez", async () => {
        const token = tokenDe(enlaceDe(ultimoCorreo()));
        assert.equal((await req("POST", "/api/auth/invitacion", { body: { token, password: "corta" } })).status, 400);
        const ok = await req("POST", "/api/auth/invitacion", { body: { token, password: "ClaveSegura123" } });
        assert.equal(ok.status, 200, JSON.stringify(ok.json));
        const login = await req("POST", "/api/auth/login", { body: { email: MAIL, password: "ClaveSegura123" } });
        assert.equal(login.status, 200);
        assert.equal(login.json.data.user.must_change_password, false, "ya eligió su contraseña: no se le pide cambiarla otra vez");
        assert.equal(login.json.data.user.is_owner, true);
        // Segundo uso: rechazado.
        assert.equal((await req("POST", "/api/auth/invitacion", { body: { token, password: "OtraClave12345" } })).status, 404);
        assert.equal((await req("GET", `/api/auth/invitacion/${token}`)).status, 404);
        assert.equal((await req("POST", "/api/auth/login", { body: { email: MAIL, password: "OtraClave12345" } })).status, 401);
    });

    it("un enlace vencido no sirve", async () => {
        const mail2 = "owner.vencido@invitacion.test";
        const r = await req("POST", "/api/platform/empresas", {
            token: tokPlat, body: { empresa: { nombre: "Invitada SA 2" }, owner: { nombre: "Otro", email: mail2, codigo_ingreso: "OWN-V" } },
        });
        assert.equal(r.status, 201);
        const token = tokenDe(enlaceDe(ultimoCorreo()));
        await pool.query("UPDATE usuario_tokens SET expira_at = now() - interval '1 minute' WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)", [mail2]);
        assert.equal((await req("GET", `/api/auth/invitacion/${token}`)).status, 404);
        assert.equal((await req("POST", "/api/auth/invitacion", { body: { token, password: "ClaveSegura123" } })).status, 404);
    });

    it("reenviar: genera un enlace nuevo que anula el anterior; no aplica si el owner ya activó su cuenta", async () => {
        const mail3 = "owner.reenvio@invitacion.test";
        const alta = await req("POST", "/api/platform/empresas", {
            token: tokPlat, body: { empresa: { nombre: "Invitada SA 3" }, owner: { nombre: "Tercero", email: mail3, codigo_ingreso: "OWN-R" } },
        });
        const id3 = alta.json.data.empresa.id;
        const viejo = tokenDe(enlaceDe(ultimoCorreo()));
        const re = await req("POST", `/api/platform/empresas/${id3}/reenviar-invitacion`, { token: tokPlat });
        assert.equal(re.status, 200, JSON.stringify(re.json));
        assert.equal(re.json.data.enviada, true);
        const nuevo = tokenDe(enlaceDe(ultimoCorreo()));
        assert.notEqual(nuevo, viejo);
        assert.equal((await req("GET", `/api/auth/invitacion/${viejo}`)).status, 404, "el enlace anterior queda anulado");
        assert.equal((await req("GET", `/api/auth/invitacion/${nuevo}`)).status, 200);
        // La empresa 1 ya activó su cuenta.
        assert.equal((await req("POST", `/api/platform/empresas/${empresaId}/reenviar-invitacion`, { token: tokPlat })).status, 409);
        // Solo el usuario maestro.
        const idOwner = (await pool.query("SELECT id FROM usuarios WHERE email = $1", [MAIL])).rows[0].id;
        const tokOwner = signToken({ id: idOwner, empresa_id: empresaId, is_admin: true, is_owner: true, tv: 1 });
        assert.equal((await req("POST", `/api/platform/empresas/${id3}/reenviar-invitacion`, { token: tokOwner })).status, 403);
    });

    it("el alta con contraseña (flujo anterior) sigue funcionando y no envía correo", async () => {
        const antes = correosDePrueba.length;
        const r = await req("POST", "/api/platform/empresas", {
            token: tokPlat, body: { empresa: { nombre: "Invitada SA 4" }, owner: { nombre: "Cuarto", email: "owner.clasico@invitacion.test", codigo_ingreso: "OWN-C", password: "Temporal123" } },
        });
        assert.equal(r.status, 201);
        assert.equal(r.json.data.invitacion, undefined);
        assert.equal(correosDePrueba.length, antes);
        assert.equal((await req("POST", "/api/auth/login", { body: { email: "owner.clasico@invitacion.test", password: "Temporal123" } })).status, 200);
    });
});
