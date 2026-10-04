import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — empresa recién creada: primeros pasos y áreas de categorías", { skip: SKIP }, () => {
    const E = 9481;
    let server, base, pool, signToken, tok;

    const req = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const pasos = async () => (await req("GET", `/api/reportes/${E}/primeros-pasos`)).json.data;
    const hecho = (p, id) => p.pasos.find((x) => x.id === id).hecho;

    const limpiar = async () => {
        const e = [[E]];
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM mesas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM areas_preparacion WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Empresa nueva')", [E]);
        const id = (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('EN-own','EN-own',true,true,$1) RETURNING id", [E])).rows[0].id;
        tok = signToken({ id, empresa_id: E, is_admin: true, is_owner: true, tv: 0 });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("una empresa sin datos: ningún paso hecho y no está lista", async () => {
        const p = await pasos();
        assert.equal(p.listo, false);
        assert.ok(p.pasos.every((x) => x.hecho === false));
        assert.deepEqual(p.pasos.filter((x) => x.requerido).map((x) => x.id), ["categorias", "insumos", "recetas", "mesas"]);
        const pos = (await req("GET", `/api/reportes/${E}/pos`)).json.data;
        assert.equal(pos.activo, false);
    });

    it("las categorías de bebidas nacen asignadas a Barra (aunque las áreas aún no existieran); las demás no", async () => {
        const bebidas = await req("POST", `/api/categorias/${E}`, { nombre: "Bebidas", tipo: "RECETA" });
        assert.equal(bebidas.status, 201);
        const areas = (await req("GET", `/api/pos/${E}/areas`)).json.data;
        const barra = areas.find((a) => a.nombre === "Barra");
        assert.ok(barra && areas.some((a) => a.nombre === "Cocina" && a.es_default), "las áreas por defecto se sembraron");
        assert.equal(bebidas.json.data.area_id, barra.id);
        const postres = await req("POST", `/api/categorias/${E}`, { nombre: "Postres", tipo: "RECETA" });
        assert.equal(postres.json.data.area_id, null);
        const insumos = await req("POST", `/api/categorias/${E}`, { nombre: "Insumos secos", tipo: "PRODUCTO" });
        const asig = (await req("GET", `/api/pos/${E}/asignacion-areas`)).json.data;
        assert.equal(asig.find((c) => c.nombre === "Bebidas").area_id, barra.id);
        assert.equal(asig.find((c) => c.nombre === "Postres").area_id, null);
        assert.equal(insumos.status, 201);
    });

    it("un platillo de la categoría Bebidas sale por Barra en el menú del POS", async () => {
        const prov = (await req("POST", `/api/proveedores/${E}`, { nombre: "Prov" })).json.data;
        const prod = (await req("POST", `/api/productos/${E}`, {
            producto: "Café", categoria: "Insumos secos", proveedor_id: prov.id, cantidad_presentacion: 1000, costo_presentacion: 250, stock_actual: 1000, stock_minimo: 100, unidad_medida: "g",
        })).json.data;
        const rec = await req("POST", `/api/recetas/${E}`, { nombre: "Latte", categoria: "Bebidas", precio_venta: 58, ingredientes: [{ producto_id: prod.id, cantidad: 18 }] });
        assert.equal(rec.status, 201, JSON.stringify(rec.json));
        const menu = (await req("GET", `/api/pos/${E}/menu`)).json.data.articulos.find((a) => a.nombre === "Latte");
        assert.equal(menu.area_origen, "CATEGORIA");
        const areas = (await req("GET", `/api/pos/${E}/areas`)).json.data;
        assert.equal(menu.area_id, areas.find((a) => a.nombre === "Barra").id);
    });

    it("los primeros pasos avanzan con los datos reales y la empresa queda lista al completar los requeridos", async () => {
        let p = await pasos();
        assert.equal(hecho(p, "categorias"), true);
        assert.equal(hecho(p, "proveedores"), true);
        assert.equal(hecho(p, "insumos"), true);
        assert.equal(hecho(p, "recetas"), true);
        assert.equal(hecho(p, "mesas"), false);
        assert.equal(p.listo, false, "falta al menos una mesa");
        await req("POST", `/api/pos/${E}/mesas`, { nombre: "Mesa 1", capacidad: 4 });
        p = await pasos();
        assert.equal(hecho(p, "mesas"), true);
        assert.equal(p.listo, true);
        assert.equal(hecho(p, "primera_venta"), false);
        assert.equal(hecho(p, "equipo"), false);
    });
});
