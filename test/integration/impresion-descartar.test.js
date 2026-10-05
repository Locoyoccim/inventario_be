import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Descartar trabajos de la cola de impresión (sin borrarlos) y recuperarlos con «Reimprimir».

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — descartar trabajos de impresión", { skip: SKIP }, () => {
    const A = 9781;
    const B = 9782;
    let server, base, pool, signToken, tokAdmin, tokAdminB, tokMesero, tokSupervisor, impresoraId;

    const req = async (method, path, { token = tokAdmin, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const trabajo = async (estado, { tipo = "PRUEBA", empresa = A, referencia = impresoraId } = {}) =>
        (await pool.query(
            "INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, estado, payload) VALUES ($1,$2,$3,$4,$5,'{}') RETURNING id",
            [empresa, tipo, referencia, impresoraId, estado],
        )).rows[0].id;
    const cola = async (estado, token = tokAdmin) => (await req("GET", `/api/pos/${A}/impresiones${estado ? `?estado=${estado}` : ""}`, { token })).json.data;
    const estadoDe = async (id) => (await pool.query("SELECT estado, descartada_por FROM pos_impresiones WHERE id = $1", [id])).rows[0];

    const limpiar = async () => {
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM areas_preparacion WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    };
    const mkUsuario = async (empresa, codigo, { admin = false, rol = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id", [codigo, admin, empresa, rolId])).rows[0].id;
        return signToken({ id, empresa_id: empresa, is_admin: admin, is_owner: admin, tv: 0 });
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Con cola'), ($2,'Otra')", [A, B]);
        tokAdmin = await mkUsuario(A, "DC-adm", { admin: true });
        tokAdminB = await mkUsuario(B, "DC-admB", { admin: true });
        tokMesero = await mkUsuario(A, "DC-mes", { rol: "mesero" });
        tokSupervisor = await mkUsuario(A, "DC-sup", { rol: "supervisor" });
        impresoraId = (await pool.query("INSERT INTO impresoras (empresa_id,nombre,conexion,ip,es_ticket) VALUES ($1,'Tickets','RED','10.0.0.9',true) RETURNING id", [A])).rows[0].id;
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("descarta lo pendiente, con error o sin impresora; lo impreso y lo que el agente imprime ahora, no", async () => {
        const ids = { pendiente: await trabajo("PENDIENTE"), error: await trabajo("ERROR"), sin: await trabajo("SIN_IMPRESORA") };
        for (const [k, id] of Object.entries(ids)) {
            const r = await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`);
            assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.json)}`);
            assert.equal(r.json.data.estado, "DESCARTADA");
            assert.equal((await estadoDe(id)).estado, "DESCARTADA");
        }
        const impreso = await trabajo("IMPRESO");
        const imprimiendo = await trabajo("IMPRIMIENDO");
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${impreso}/descartar`)).status, 409);
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${imprimiendo}/descartar`)).status, 409);
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${ids.error}/descartar`)).status, 409, "ya descartado");
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/99999999/descartar`)).status, 404);
        assert.equal((await estadoDe(impreso)).estado, "IMPRESO");
        assert.equal((await estadoDe(imprimiendo)).estado, "IMPRIMIENDO");
    });

    it("la fila no se borra: sale de la lista normal, aparece en «Descartadas» y queda quién la descartó", async () => {
        const id = await trabajo("ERROR");
        await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`);
        assert.ok(!(await cola()).some((t) => t.id === id), "no sale en la lista normal");
        assert.ok(!(await cola("ERROR")).some((t) => t.id === id));
        assert.ok((await cola("DESCARTADA")).some((t) => t.id === id), "se puede consultar");
        const f = await estadoDe(id);
        assert.ok(f.descartada_por, "queda quién lo descartó");
    });

    it("se puede recuperar con Reimprimir (vuelve a la cola) y un ticket descartado sigue siendo reimprimible", async () => {
        const id = await trabajo("SIN_IMPRESORA");
        await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`);
        const r = await req("POST", `/api/pos/${A}/impresiones/${id}/reimprimir`);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.estado, "PENDIENTE");
        const f = (await pool.query("SELECT descartada_at, descartada_por, reimpresiones FROM pos_impresiones WHERE id = $1", [id])).rows[0];
        assert.equal(f.descartada_at, null);
        assert.equal(f.descartada_por, null);
        assert.equal(f.reimpresiones, 0, "recuperar algo que nunca salió no cuenta como copia");
        assert.ok((await cola("PENDIENTE")).some((t) => t.id === id));
    });

    it("descartar todo de una vez limpia solo lo atorado de la empresa y respeta el filtro de estados", async () => {
        await pool.query("UPDATE pos_impresiones SET estado = 'IMPRESO' WHERE empresa_id = $1 AND estado = 'PENDIENTE'", [A]);
        const p = await trabajo("PENDIENTE");
        const e = await trabajo("ERROR");
        const s = await trabajo("SIN_IMPRESORA");
        const impreso = await trabajo("IMPRESO");
        const ajeno = await trabajo("PENDIENTE", { empresa: B });

        const solo = await req("POST", `/api/pos/${A}/impresiones/descartar`, { body: { estados: ["ERROR"] } });
        assert.deepEqual(solo.json.data, { descartados: 1 });
        assert.equal((await estadoDe(e)).estado, "DESCARTADA");
        assert.equal((await estadoDe(p)).estado, "PENDIENTE");

        const todo = await req("POST", `/api/pos/${A}/impresiones/descartar`, { body: {} });
        assert.deepEqual(todo.json.data, { descartados: 2 });
        assert.equal((await estadoDe(p)).estado, "DESCARTADA");
        assert.equal((await estadoDe(s)).estado, "DESCARTADA");
        assert.equal((await estadoDe(impreso)).estado, "IMPRESO");
        assert.equal((await estadoDe(ajeno)).estado, "PENDIENTE", "no toca a otra empresa");
        assert.deepEqual((await req("POST", `/api/pos/${A}/impresiones/descartar`, { body: {} })).json.data, { descartados: 0 });
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/descartar`, { body: { estados: ["IMPRESO"] } })).status, 400, "no se puede pedir descartar lo impreso");
    });

    it("solo quien autoriza (supervisor o Admin) descarta; otra empresa no ve los trabajos", async () => {
        const id = await trabajo("ERROR");
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`, { token: tokMesero })).status, 403);
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/descartar`, { token: tokMesero, body: {} })).status, 403);
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`, { token: tokAdminB })).status, 403, "empresaGuard");
        assert.equal((await req("POST", `/api/pos/${B}/impresiones/${id}/descartar`, { token: tokAdminB })).status, 404, "otra empresa no lo ve");
        assert.equal((await req("POST", `/api/pos/${A}/impresiones/${id}/descartar`, { token: tokSupervisor })).status, 200);
    });

    it("lo descartado ya no lo toma el agente ni cuenta como error de la empresa", async () => {
        await pool.query("UPDATE pos_impresiones SET estado = 'IMPRESO' WHERE empresa_id = $1 AND estado IN ('PENDIENTE','IMPRIMIENDO','ERROR','SIN_IMPRESORA')", [A]);
        const id = await trabajo("PENDIENTE");
        const err = await trabajo("ERROR");
        const antes = (await req("GET", `/api/pos/${A}/impresion/estado`)).json.data;
        assert.equal(antes.pendientes, 1);
        assert.equal(antes.errores, 1);
        await req("POST", `/api/pos/${A}/impresiones/descartar`, { body: {} });
        const despues = (await req("GET", `/api/pos/${A}/impresion/estado`)).json.data;
        assert.equal(despues.pendientes, 0);
        assert.equal(despues.errores, 0);
        assert.equal((await estadoDe(id)).estado, "DESCARTADA");
        assert.equal((await estadoDe(err)).estado, "DESCARTADA");
    });
});
