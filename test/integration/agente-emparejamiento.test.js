import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Emparejamiento del agente de impresión por código (en lugar de copiar el token) y manifiesto de versión.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — emparejamiento del agente de impresión", { skip: SKIP }, () => {
    const A = 9771;
    const B = 9772;
    let server, base, pool, signToken, tokAdmin, tokAdminB, tokOperativo;

    const req = async (method, path, { token, body, headers = {} } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const crear = async (nombre = "Caja") => {
        const r = await req("POST", `/api/pos/${A}/agentes`, { token: tokAdmin, body: { nombre } });
        assert.equal(r.status, 201, JSON.stringify(r.json));
        return r.json.data;
    };
    const emparejar = (codigo, equipo = "PC-CAJA") => req("POST", "/api/agente/emparejar", { body: { codigo, equipo } });
    const pendientes = (token) => req("GET", "/api/agente/impresiones/pendientes", { token });

    const limpiar = async () => {
        await pool.query("DELETE FROM agentes_impresion WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    };
    const mkUsuario = async (empresa, codigo, admin) => {
        const id = (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ($1,$1,$2,$2,$3) RETURNING id", [codigo, admin, empresa])).rows[0].id;
        return signToken({ id, empresa_id: empresa, is_admin: admin, is_owner: admin, tv: 0 });
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Con agente'), ($2,'Otra')", [A, B]);
        tokAdmin = await mkUsuario(A, "AG-adm", true);
        tokAdminB = await mkUsuario(B, "AG-admB", true);
        tokOperativo = await mkUsuario(A, "AG-op", false);
    });

    after(async () => {
        delete process.env.AGENTE_ULTIMA_VERSION;
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("crear un agente entrega token y un código; el código se canjea una sola vez por un token NUEVO", async () => {
        const c = await crear();
        assert.match(c.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        assert.equal(c.vigencia_min, 15);
        const enBd = (await pool.query("SELECT codigo_hash FROM agentes_impresion WHERE id = $1", [c.agente.id])).rows[0];
        assert.ok(enBd.codigo_hash && !enBd.codigo_hash.includes(c.codigo), "solo queda el hash");
        assert.equal((await pendientes(c.token)).status, 200, "el token manual sigue sirviendo hasta emparejar");

        assert.equal((await emparejar("ZZZZ-ZZZZ")).status, 400);
        const r = await emparejar(c.codigo.toLowerCase().replace("-", " "), "PC-DE-CAJA");
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.match(r.json.data.token, /^gh_agt_[0-9a-f]{48}$/);
        assert.notEqual(r.json.data.token, c.token);
        assert.equal(r.json.data.servidor, base);
        assert.equal(r.json.data.agente.nombre, "Caja");

        assert.equal((await pendientes(c.token)).status, 401, "el token anterior deja de valer");
        assert.equal((await pendientes(r.json.data.token)).status, 200);
        assert.equal((await emparejar(c.codigo)).status, 400, "el código es de un solo uso");
        const fila = (await pool.query("SELECT equipo, emparejado_at, codigo_hash FROM agentes_impresion WHERE id = $1", [c.agente.id])).rows[0];
        assert.equal(fila.equipo, "PC-DE-CAJA");
        assert.ok(fila.emparejado_at);
        assert.equal(fila.codigo_hash, null);
    });

    it("el código vence, un código nuevo reemplaza al anterior y un agente desactivado no se empareja", async () => {
        const c = await crear("Vencido");
        await pool.query("UPDATE agentes_impresion SET codigo_expira_at = now() - interval '1 minute' WHERE id = $1", [c.agente.id]);
        assert.equal((await emparejar(c.codigo)).status, 400);

        const n1 = await req("POST", `/api/pos/${A}/agentes/${c.agente.id}/codigo`, { token: tokAdmin });
        assert.equal(n1.status, 200);
        const n2 = await req("POST", `/api/pos/${A}/agentes/${c.agente.id}/codigo`, { token: tokAdmin });
        assert.equal((await emparejar(n1.json.data.codigo)).status, 400, "el código anterior ya no sirve");

        await req("PUT", `/api/pos/${A}/agentes/${c.agente.id}`, { token: tokAdmin, body: { activo: false } });
        assert.equal((await emparejar(n2.json.data.codigo)).status, 400, "agente desactivado");
        assert.equal((await req("POST", `/api/pos/${A}/agentes/${c.agente.id}/codigo`, { token: tokAdmin })).status, 404);
    });

    it("solo Admin de la misma empresa genera códigos; el canje no filtra datos de otra empresa", async () => {
        const c = await crear("Aislado");
        assert.equal((await req("POST", `/api/pos/${A}/agentes/${c.agente.id}/codigo`, { token: tokOperativo })).status, 403);
        assert.equal((await req("POST", `/api/pos/${A}/agentes/${c.agente.id}/codigo`, { token: tokAdminB })).status, 403, "empresaGuard");
        // el admin de B no puede usar la URL de B con un agente de A
        assert.equal((await req("POST", `/api/pos/${B}/agentes/${c.agente.id}/codigo`, { token: tokAdminB })).status, 404);
        const r = await emparejar(c.codigo);
        assert.deepEqual(Object.keys(r.json.data).sort(), ["agente", "servidor", "token", "zona_horaria"]);
        assert.ok(r.json.data.zona_horaria, "la zona horaria es de la empresa");
        assert.deepEqual(Object.keys(r.json.data.agente).sort(), ["id", "nombre"], "no se expone empresa_id");
    });

    it("eliminar un agente: solo Admin de su empresa; su token y su código dejan de servir", async () => {
        const c = await crear("Para borrar");
        assert.equal((await req("DELETE", `/api/pos/${A}/agentes/${c.agente.id}`, { token: tokOperativo })).status, 403);
        assert.equal((await req("DELETE", `/api/pos/${A}/agentes/${c.agente.id}`, { token: tokAdminB })).status, 403, "empresaGuard");
        assert.equal((await req("DELETE", `/api/pos/${B}/agentes/${c.agente.id}`, { token: tokAdminB })).status, 404, "otra empresa no lo ve");
        assert.equal((await pendientes(c.token)).status, 200);

        const r = await req("DELETE", `/api/pos/${A}/agentes/${c.agente.id}`, { token: tokAdmin });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.nombre, "Para borrar");
        assert.equal((await pendientes(c.token)).status, 401, "el token ya no sirve");
        assert.equal((await emparejar(c.codigo)).status, 400, "el código tampoco");
        assert.equal((await req("DELETE", `/api/pos/${A}/agentes/${c.agente.id}`, { token: tokAdmin })).status, 404);
        const lista = (await req("GET", `/api/pos/${A}/agentes`, { token: tokAdmin })).json.data;
        assert.ok(!lista.some((a) => a.id === c.agente.id));
    });

    it("el listado muestra equipo, código pendiente y si el agente está desactualizado", async () => {
        process.env.AGENTE_ULTIMA_VERSION = "9.9.9";
        const c = await crear("Listado");
        const antes = (await req("GET", `/api/pos/${A}/agentes`, { token: tokAdmin })).json.data.find((a) => a.id === c.agente.id);
        assert.equal(antes.codigo_pendiente, true);
        assert.equal(antes.token_hash, undefined);
        assert.equal(antes.codigo_hash, undefined);

        const r = await emparejar(c.codigo, "PC-X");
        await req("GET", "/api/agente/impresiones/pendientes", { token: r.json.data.token, headers: { "X-Agent-Version": "1.6.0" } });
        const despues = (await req("GET", `/api/pos/${A}/agentes`, { token: tokAdmin })).json.data.find((a) => a.id === c.agente.id);
        assert.equal(despues.codigo_pendiente, false);
        assert.equal(despues.equipo, "PC-X");
        assert.equal(despues.version, "1.6.0");
        assert.equal(despues.desactualizado, true);

        const info = await req("GET", `/api/pos/${A}/agentes-info`, { token: tokAdmin });
        assert.equal(info.json.data.manifiesto.version, "9.9.9");
        assert.equal((await req("GET", `/api/pos/${A}/agentes-info`, { token: tokOperativo })).status, 403);

        const v = await req("GET", "/api/agente/version", { token: r.json.data.token });
        assert.equal(v.status, 200);
        assert.equal(v.json.data.manifiesto.version, "9.9.9");
        assert.equal((await req("GET", "/api/agente/version")).status, 401, "el manifiesto exige el token del agente");

        delete process.env.AGENTE_ULTIMA_VERSION;
        assert.equal((await req("GET", "/api/agente/version", { token: r.json.data.token })).json.data.manifiesto, null);
    });
});
