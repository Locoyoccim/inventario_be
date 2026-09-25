import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — Categorías: cascada, reasignación y tipo", { skip: SKIP }, () => {
    const A = 9501;
    let server, base, pool, signToken;
    let tok, provId, ingId;

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

    const catId = async (nombre, tipo) => (await req("POST", `/api/categorias/${A}`, { token: tok, body: tipo ? { nombre, tipo } : { nombre } })).json.data.id;
    const mkProd = async (producto, categoria) => (await req("POST", `/api/productos/${A}`, {
        token: tok, body: { producto, unidad_medida: "g", proveedor_id: provId, categoria, cantidad_presentacion: 1000, costo_presentacion: 10, stock_actual: 100, stock_minimo: 10 },
    })).json.data.id;
    const mkRecipe = async (nombre, categoria) => (await req("POST", `/api/recetas/${A}`, {
        token: tok, body: { nombre, categoria, precio_venta: 30, ingredientes: [{ producto_id: ingId, cantidad: 5 }] },
    })).json.data.id;
    const catText = async (table, id) => (await pool.query(`SELECT categoria FROM ${table} WHERE id=$1`, [id])).rows[0]?.categoria;
    const tipoDe = async (nombre) => (await pool.query("SELECT tipo FROM categorias WHERE empresa_id=$1 AND lower(nombre)=lower($2)", [A, nombre])).rows[0]?.tipo;
    const countCat = async (nombre) => Number((await pool.query("SELECT COUNT(*)::int c FROM categorias WHERE empresa_id=$1 AND lower(nombre)=lower($2)", [A, nombre])).rows[0].c);

    const limpiar = async () => {
        const e = [[A]];
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_map WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
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
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Cat A')", [A]);
        const adminId = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','CA-adm',true,true,$1) RETURNING id", [A])).rows[0].id;
        tok = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        provId = (await req("POST", `/api/proveedores/${A}`, { token: tok, body: { nombre: "Prov" } })).json.data.id;
        ingId = await mkProd("Ingrediente base", "Insumo");
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("renombrar en cascada actualiza productos y recetas", async () => {
        const id = await catId("Lacteos");
        const p1 = await mkProd("Leche", "Lacteos");
        const p2 = await mkProd("Queso", "Lacteos");
        const r1 = await mkRecipe("Flan", "Lacteos");
        const put = await req("PUT", `/api/categorias/${A}/${id}`, { token: tok, body: { nombre: "Lácteos" } });
        assert.equal(put.status, 200);
        assert.equal(put.json.data.nombre, "Lácteos");
        assert.equal(put.json.data.productos_actualizados, 2);
        assert.equal(put.json.data.recetas_actualizadas, 1);
        assert.equal(await catText("productos", p1), "Lácteos");
        assert.equal(await catText("productos", p2), "Lácteos");
        assert.equal(await catText("recetas", r1), "Lácteos");
    });

    it("renombrar a un nombre existente (distinta mayúscula) → 409 y nada cambia", async () => {
        const idA = await catId("AlfaX");
        await catId("BetaX");
        const put = await req("PUT", `/api/categorias/${A}/${idA}`, { token: tok, body: { nombre: "betax" } });
        assert.equal(put.status, 409);
        const still = (await pool.query("SELECT nombre FROM categorias WHERE id=$1", [idA])).rows[0].nombre;
        assert.equal(still, "AlfaX", "no cambió");
    });

    it("eliminar en uso: 409 sin reasignar; con reasignar_a mueve y borra", async () => {
        const src = await catId("SrcCat");
        const dst = await catId("DstCat");
        const prod = await mkProd("Producto del src", "SrcCat");
        // Sin reasignar -> 409 con conteos
        const noReasg = await req("DELETE", `/api/categorias/${A}/${src}`, { token: tok });
        assert.equal(noReasg.status, 409);
        assert.deepEqual(noReasg.json.details, { productos: 1, recetas: 0 });
        // reasignar_a a la misma categoría -> 400
        assert.equal((await req("DELETE", `/api/categorias/${A}/${src}?reasignar_a=${src}`, { token: tok })).status, 400);
        // reasignar_a inexistente/otra empresa -> 400
        assert.equal((await req("DELETE", `/api/categorias/${A}/${src}?reasignar_a=99999999`, { token: tok })).status, 400);
        // reasignar correcto
        const ok = await req("DELETE", `/api/categorias/${A}/${src}?reasignar_a=${dst}`, { token: tok });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.data.productos_movidos, 1);
        assert.equal(await catText("productos", prod), "DstCat", "el producto pasó al destino");
        assert.equal((await pool.query("SELECT 1 FROM categorias WHERE id=$1", [src])).rowCount, 0, "la categoría origen se borró");
    });

    it("migración 017: inserta nombres faltantes con su tipo y es idempotente", async () => {
        // Nombres usados por productos/recetas que NO existen en la tabla categorias.
        await mkProd("Harina", "MigProd");
        await mkRecipe("Pan integral", "MigRec");
        // Categoría existente usada por producto Y receta -> debe quedar AMBAS tras backfill.
        await catId("AmbasUse", "PRODUCTO");
        await mkProd("Cosa ambas", "AmbasUse");
        await mkRecipe("Receta ambas", "AmbasUse");

        const sql = readFileSync("db/migrations/017_categorias_tipo.sql", "utf8");
        await pool.query(sql); // re-ejecuta la migración real
        assert.equal(await tipoDe("MigProd"), "PRODUCTO");
        assert.equal(await tipoDe("MigRec"), "RECETA");
        assert.equal(await tipoDe("AmbasUse"), "AMBAS", "usada por producto y receta");
        assert.equal(await countCat("MigProd"), 1);

        // Idempotente: correrla de nuevo no duplica ni cambia conteos.
        await pool.query(sql);
        assert.equal(await countCat("MigProd"), 1);
        assert.equal(await countCat("MigRec"), 1);
        assert.equal(await tipoDe("AmbasUse"), "AMBAS");
    });

    it("GET ?tipo=PRODUCTO devuelve PRODUCTO + AMBAS, no RECETA", async () => {
        await catId("SoloProdX", "PRODUCTO");
        await catId("SoloRecX", "RECETA");
        await catId("AmbasX", "AMBAS");
        const prod = await req("GET", `/api/categorias/${A}?tipo=PRODUCTO`, { token: tok });
        const nombres = prod.json.data.map((c) => c.nombre);
        assert.ok(nombres.includes("SoloProdX"));
        assert.ok(nombres.includes("AmbasX"));
        assert.ok(!nombres.includes("SoloRecX"), "no incluye las de tipo RECETA");
        const rec = await req("GET", `/api/categorias/${A}?tipo=RECETA`, { token: tok });
        const nombresR = rec.json.data.map((c) => c.nombre);
        assert.ok(nombresR.includes("SoloRecX"));
        assert.ok(nombresR.includes("AmbasX"));
        assert.ok(!nombresR.includes("SoloProdX"));
    });

    it("crear una preparación asegura la categoría \"Preparación\" (tipo PRODUCTO)", async () => {
        await req("POST", `/api/recetas/${A}`, {
            token: tok,
            body: { nombre: "Salsa base", categoria: "Salsas", precio_venta: 0, es_preparacion: true, rendimiento: 1000, unidad: "ml", stock_minimo: 100, ingredientes: [{ producto_id: ingId, cantidad: 50 }] },
        });
        assert.equal(await tipoDe("Preparación"), "PRODUCTO", "la categoría Preparación existe y es de producto");
    });
});
