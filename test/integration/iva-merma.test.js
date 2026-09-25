import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — IVA en precios + merma de limpieza", { skip: SKIP }, () => {
    const A = 9601;
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
    const mkInsumo = async (producto, { cant = 1000, costo = 200, merma = 0, stock = 5000 } = {}) => (await req("POST", `/api/productos/${A}`, {
        token: tok, body: { producto, unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: cant, costo_presentacion: costo, stock_actual: stock, stock_minimo: 0, merma_pct: merma },
    })).json.data.id;
    const stockDe = async (pid) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id=$1", [pid])).rows[0].stock_actual);

    const limpiar = async () => {
        const e = [[A]];
        await pool.query("DELETE FROM ingresos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias_gasto WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_map WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
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
        // Empresa con IVA 16, precios con IVA, food cost objetivo 30 (defaults migración 018).
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'IVA A')", [A]);
        const adminId = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','IV-adm',true,true,$1) RETURNING id", [A])).rows[0].id;
        tok = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        provId = (await req("POST", `/api/proveedores/${A}`, { token: tok, body: { nombre: "Prov" } })).json.data.id;
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("empresa: GET/PUT configuración", async () => {
        const g = await req("GET", `/api/empresas/${A}/configuracion`, { token: tok });
        assert.equal(g.status, 200);
        assert.equal(Number(g.json.data.iva_pct), 16);
        assert.equal(g.json.data.precios_incluyen_iva, true);
        assert.equal(Number(g.json.data.food_cost_objetivo), 30);
        const p = await req("PUT", `/api/empresas/${A}/configuracion`, { token: tok, body: { food_cost_objetivo: 35 } });
        assert.equal(p.status, 200);
        assert.equal(Number(p.json.data.food_cost_objetivo), 35);
        // regresar a 30 para las demás pruebas
        await req("PUT", `/api/empresas/${A}/configuracion`, { token: tok, body: { food_cost_objetivo: 30 } });
    });

    it("receta con IVA: precio_neto/iva_monto/costo_pct/margen/utilidad/precio_sugerido (prueba 1)", async () => {
        const ins = await mkInsumo("Insumo35", { cant: 1, costo: 35, merma: 0 });
        const r = await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Platillo IVA", categoria: "Platillos", precio_venta: 110, ingredientes: [{ producto_id: ins, cantidad: 1 }] },
        });
        assert.equal(r.status, 201);
        const d = r.json.data;
        assert.equal(Number(d.costo_total), 35);
        assert.equal(Number(d.precio_neto), 94.83);
        assert.equal(Number(d.iva_monto), 15.17);
        assert.equal(Number(d.costo_pct), 36.91);
        assert.equal(Number(d.margen), 63.09);
        assert.equal(Number(d.utilidad), 59.83);
        assert.equal(Number(d.precio_sugerido), 135);
    });

    it("receta con precio_incluye_iva=false: neto = precio", async () => {
        const ins = await mkInsumo("Insumo30", { cant: 1, costo: 30, merma: 0 });
        const r = await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Sin IVA", categoria: "Platillos", precio_venta: 100, precio_incluye_iva: false, ingredientes: [{ producto_id: ins, cantidad: 1 }] },
        });
        assert.equal(Number(r.json.data.precio_neto), 100);
        assert.equal(Number(r.json.data.iva_monto), 0);
    });

    it("merma: costo_util del aguacate y costo de receta en neto (prueba 3)", async () => {
        const agu = await mkInsumo("Aguacate", { cant: 1000, costo: 200, merma: 8 });
        const p = await req("GET", `/api/productos/${A}/${agu}`, { token: tok });
        assert.equal(Number(p.json.data.costo_util), 0.2174);
        const r = await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Guacamole", categoria: "Platillos", precio_venta: 0, ingredientes: [{ producto_id: agu, cantidad: 100 }] },
        });
        assert.equal(Number(r.json.data.costo_total), 21.74);
    });

    it("cascada: cambiar la merma recalcula recetas (prueba 4)", async () => {
        const agu = await mkInsumo("Aguacate cascada", { cant: 1000, costo: 200, merma: 8 });
        await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Guac cascada", categoria: "Platillos", precio_venta: 0, ingredientes: [{ producto_id: agu, cantidad: 100 }] },
        });
        const put = await req("PUT", `/api/productos/${A}/${agu}`, {
            token: tok, body: { producto: "Aguacate cascada", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 200, stock_minimo: 0, merma_pct: 10 },
        });
        assert.ok(put.json.data.recetas_actualizadas >= 1, "recetas recalculadas en cascada");
        // 0.2 / 0.90 = 0.2222 ; ×100 = 22.22
        const costo = Number((await pool.query("SELECT costo_total FROM recetas WHERE empresa_id=$1 AND nombre='Guac cascada'", [A])).rows[0].costo_total);
        assert.equal(costo, 22.22);
    });

    it("inventario en bruto: 100 g netos -> VENTA 108.696 y revertir exacto (prueba 5)", async () => {
        const agu = await mkInsumo("Aguacate venta", { cant: 1000, costo: 200, merma: 8, stock: 5000 });
        await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Guac venta", categoria: "Platillos", precio_venta: 90, ingredientes: [{ producto_id: agu, cantidad: 100 }] },
        });
        const rec = (await pool.query("SELECT id FROM recetas WHERE empresa_id=$1 AND nombre='Guac venta'", [A])).rows[0].id;
        await req("POST", `/api/pos-map/${A}`, { token: tok, body: { nombre_pos: "Guac venta", tipo: "RECETA", receta_id: rec, factor: 1 } });
        const fecha = "2026-11-01";
        const imp = await req("POST", `/api/ventas/${A}/importar`, { token: tok, body: { fecha, lineas: [{ nombre_pos: "Guac venta", cantidad: 1 }] } });
        assert.equal(imp.status, 201);
        const mov = Number((await pool.query("SELECT cantidad FROM movimientosinventario WHERE producto_id=$1 AND tipo_movimiento='VENTA' ORDER BY id DESC LIMIT 1", [agu])).rows[0].cantidad);
        assert.equal(mov, 108.696, "descuenta bruto");
        assert.equal(await stockDe(agu), Number((5000 - 108.696).toFixed(3)));
        // revertir devuelve exactamente lo descontado
        assert.equal((await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tok })).status, 200);
        assert.equal(await stockDe(agu), 5000);
    });

    it("producción estricta en bruto: existencia insuficiente -> error (prueba 6)", async () => {
        const ins = await mkInsumo("Insumo prod", { cant: 1000, costo: 100, merma: 8, stock: 105 });
        const prep = await req("POST", `/api/recetas/${A}`, {
            token: tok, body: { nombre: "Prep estricta", categoria: "Salsas", precio_venta: 0, es_preparacion: true, rendimiento: 1000, unidad: "ml", stock_minimo: 0, ingredientes: [{ producto_id: ins, cantidad: 100 }] },
        });
        const recId = prep.json.data.id;
        // requerido bruto = 100 / 0.92 = 108.696 > 105 -> error de existencia
        const conf = await req("POST", `/api/produccion/${A}/confirmar`, { token: tok, body: { producciones: [{ receta_id: recId, lotes: 1 }] } });
        assert.equal(conf.status, 400, "producción estricta falla por existencia insuficiente en bruto");
        assert.equal(await stockDe(ins), 105, "no se descontó nada");
    });

    it("finanzas: ingresos netos e IVA estimado (prueba 7)", async () => {
        await req("POST", `/api/finanzas/${A}/ingresos`, { token: tok, body: { fecha: "2026-09-15", metodo_pago: "EFECTIVO", monto: 1160 } });
        const r = await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tok });
        assert.equal(r.status, 200);
        assert.equal(Number(r.json.data.ingresos.total), 1160);
        assert.equal(Number(r.json.data.ingresos.neto), 1000);
        assert.equal(Number(r.json.data.ingresos.iva_estimado), 160);
    });
});
