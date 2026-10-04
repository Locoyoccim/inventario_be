import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — Normalización de unidades de medida", { skip: SKIP }, () => {
    const A = 9801;
    let server, base, pool, signToken, tok, provId;

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
    const unidadDe = async (id) => (await pool.query("SELECT unidad_medida FROM productos WHERE id=$1", [id])).rows[0].unidad_medida;

    const limpiar = async () => {
        const e = [[A]];
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
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
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Unid A')", [A]);
        // 028 exige que la categoría exista en el catálogo de la empresa.
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n ON CONFLICT DO NOTHING",
            [A, ["Insumo", "Salsas", "Preparación"]],
        );
        const adminId = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','UN-adm',true,true,$1) RETURNING id", [A])).rows[0].id;
        tok = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        provId = (await req("POST", `/api/proveedores/${A}`, { token: tok, body: { nombre: "Prov" } })).json.data.id;
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    const crear = (unidad) => req("POST", `/api/productos/${A}`, {
        token: tok, body: { producto: "P " + unidad, unidad_medida: unidad, proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 10, stock_actual: 0, stock_minimo: 0 },
    });

    it("POST normaliza la unidad a su forma canónica", async () => {
        const r = await crear("gr");
        assert.equal(r.status, 201);
        assert.equal(r.json.data.unidad_medida, "g");
        assert.equal(await unidadDe(r.json.data.id), "g");
        const r2 = await crear("Litros");
        assert.equal(r2.json.data.unidad_medida, "l");
    });

    it("POST rechaza unidad no válida con 400", async () => {
        const r = await crear("xyz");
        assert.equal(r.status, 400);
    });

    it("PUT normaliza la unidad", async () => {
        const id = (await crear("kg")).json.data.id;
        const put = await req("PUT", `/api/productos/${A}/${id}`, {
            token: tok, body: { producto: "P kg", unidad_medida: "Kilos", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 10, stock_minimo: 0 },
        });
        assert.equal(put.status, 200);
        assert.equal(put.json.data.unidad_medida, "kg");
    });

    it("preparación: la unidad de la receta se normaliza", async () => {
        const ins = (await crear("g")).json.data.id;
        const r = await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Salsa u", categoria: "Salsas", precio_venta: 0, es_preparacion: true, rendimiento: 1000, unidad: "Mililitros", stock_minimo: 0, ingredientes: [{ producto_id: ins, cantidad: 100 }] },
        });
        assert.equal(r.status, 201);
        // La unidad de la preparación se guarda en su producto elaborado (productos.unidad_medida).
        const elabId = (await pool.query("SELECT producto_elaborado_id FROM recetas WHERE id=$1", [r.json.data.id])).rows[0].producto_elaborado_id;
        assert.equal(await unidadDe(elabId), "ml");
    });

    it("migración 019 normaliza datos existentes y es idempotente", async () => {
        const id = (await crear("g")).json.data.id;
        // Simula un dato legacy sin normalizar (salta la validación de la API).
        await pool.query("UPDATE productos SET unidad_medida='Gramos' WHERE id=$1", [id]);
        const sql = readFileSync("db/migrations/019_normalizar_unidades.sql", "utf8");
        await pool.query(sql);
        assert.equal(await unidadDe(id), "g");
        await pool.query(sql); // idempotente
        assert.equal(await unidadDe(id), "g");
    });
});
