import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: áreas, mesas, menú y permisos", { skip: SKIP }, () => {
    const A = 9401;
    const B = 9402;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokFinanzas, tokAdminB;
    let cafeId, baguetteId, pellegrinoId, salsaId;

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

    const limpiar = async () => {
        const e = [[A, B]];
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM mesas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM areas_preparacion WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    const rolId = async (clave) => (await pool.query("SELECT id FROM roles WHERE clave = $1", [clave])).rows[0].id;
    const mkUsuario = async (empresa, codigo, { admin = false, rol = null } = {}) => {
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id",
            [codigo, admin, empresa, rol ? await rolId(rol) : null],
        )).rows[0].id;
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
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'POS A'), ($2,'POS B')", [A, B]);
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n",
            [A, ["Bebidas", "Platillos", "Insumo", "Salsas", "Preparación"]],
        );
        tokAdmin = await mkUsuario(A, "POS-adm", { admin: true });
        tokMesero = await mkUsuario(A, "POS-mes", { rol: "mesero" });
        tokFinanzas = await mkUsuario(A, "POS-fin", { rol: "finanzas" });
        tokAdminB = await mkUsuario(B, "POS-admB", { admin: true });

        const provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        const mkProducto = async (producto, extra = {}) => (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin,
            body: { producto, unidad_medida: "pz", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1, costo_presentacion: 10, stock_actual: 10, stock_minimo: 0, ...extra },
        })).json.data.id;
        const lecheId = await mkProducto("Leche");
        pellegrinoId = await mkProducto("Pellegrino", { categoria: "Bebidas", precio_venta: 45 });
        await mkProducto("Servilleta");

        const mkReceta = async (body) => (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body })).json.data.id;
        cafeId = await mkReceta({ nombre: "Latte", categoria: "Bebidas", precio_venta: 55, ingredientes: [{ producto_id: lecheId, cantidad: 1 }] });
        baguetteId = await mkReceta({ nombre: "Baguette", categoria: "Platillos", precio_venta: 120, ingredientes: [{ producto_id: lecheId, cantidad: 1 }] });
        salsaId = await mkReceta({ nombre: "Salsa", categoria: "Salsas", precio_venta: 0, es_preparacion: true, rendimiento: 1, unidad: "g", ingredientes: [{ producto_id: lecheId, cantidad: 1 }] });
        await mkReceta({ nombre: "Sin precio", categoria: "Platillos", precio_venta: 0, ingredientes: [{ producto_id: lecheId, cantidad: 1 }] });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("el perfil expone los permisos del rol", async () => {
        const me = await req("GET", "/api/auth/me", { token: tokMesero });
        assert.equal(me.status, 200);
        assert.ok(me.json.data.permisos.includes("pos.ordenar"));
        assert.ok(!me.json.data.permisos.includes("pos.cobrar"));
    });

    it("las áreas se siembran al primer uso con Cocina por defecto", async () => {
        const r = await req("GET", `/api/pos/${A}/areas`, { token: tokAdmin });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.data.map((a) => a.nombre).sort(), ["Barra", "Cocina", "Sin comanda"]);
        assert.equal(r.json.data.find((a) => a.es_default).nombre, "Cocina");
        assert.equal(r.json.data.find((a) => a.nombre === "Sin comanda").imprime, false);
    });

    it("menú: área propia > categoría > default; excluye preparaciones, sin precio e insumos", async () => {
        const areas = (await req("GET", `/api/pos/${A}/areas`, { token: tokAdmin })).json.data;
        const barra = areas.find((a) => a.nombre === "Barra").id;
        const sinComanda = areas.find((a) => a.nombre === "Sin comanda").id;
        const bebidas = (await req("GET", `/api/pos/${A}/asignacion-areas`, { token: tokAdmin })).json.data.find((c) => c.nombre === "Bebidas");
        assert.equal((await req("PUT", `/api/pos/${A}/asignacion-areas/categoria/${bebidas.id}`, { token: tokAdmin, body: { area_id: barra } })).status, 200);
        assert.equal((await req("PUT", `/api/pos/${A}/asignacion-areas/producto/${pellegrinoId}`, { token: tokAdmin, body: { area_id: sinComanda } })).status, 200);

        const menu = (await req("GET", `/api/pos/${A}/menu`, { token: tokMesero })).json.data;
        const de = (tipo, id) => menu.articulos.find((a) => a.tipo === tipo && a.id === id);
        assert.equal(de("RECETA", cafeId).area_id, barra);
        assert.equal(de("RECETA", cafeId).area_origen, "CATEGORIA");
        assert.equal(de("PRODUCTO", pellegrinoId).area_id, sinComanda);
        assert.equal(de("PRODUCTO", pellegrinoId).area_origen, "ARTICULO");
        assert.equal(de("RECETA", baguetteId).area_origen, "DEFAULT");
        assert.equal(de("RECETA", salsaId), undefined);
        assert.equal(menu.articulos.some((a) => a.nombre === "Leche" || a.nombre === "Sin precio"), false);
        assert.equal(menu.recetas_sin_precio, 1);
    });

    it("no se puede asignar un área de otra empresa ni desactivar el área por defecto", async () => {
        const areaB = (await req("GET", `/api/pos/${B}/areas`, { token: tokAdminB })).json.data[0].id;
        const r = await req("PUT", `/api/pos/${A}/asignacion-areas/receta/${cafeId}`, { token: tokAdmin, body: { area_id: areaB } });
        assert.equal(r.status, 400);
        const cocina = (await req("GET", `/api/pos/${A}/areas`, { token: tokAdmin })).json.data.find((a) => a.es_default);
        assert.equal((await req("PUT", `/api/pos/${A}/areas/${cocina.id}`, { token: tokAdmin, body: { activo: false } })).status, 400);
    });

    it("mesas: admin crea y edita; nombre duplicado 409; mesero solo lee; rol sin pos.ver 403", async () => {
        const m = await req("POST", `/api/pos/${A}/mesas`, { token: tokAdmin, body: { nombre: "Mesa 1", zona: "Terraza", capacidad: 4 } });
        assert.equal(m.status, 201);
        assert.equal((await req("POST", `/api/pos/${A}/mesas`, { token: tokAdmin, body: { nombre: "mesa 1" } })).status, 409);
        const upd = await req("PUT", `/api/pos/${A}/mesas/${m.json.data.id}`, { token: tokAdmin, body: { capacidad: 6, zona: "" } });
        assert.equal(upd.json.data.capacidad, 6);
        assert.equal(upd.json.data.zona, null);

        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: tokMesero })).status, 200);
        assert.equal((await req("POST", `/api/pos/${A}/mesas`, { token: tokMesero, body: { nombre: "Mesa 2" } })).status, 403);
        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: tokFinanzas })).status, 403);
        assert.equal((await req("GET", `/api/pos/${A}/mesas`, { token: tokAdminB })).status, 403);
    });
});
