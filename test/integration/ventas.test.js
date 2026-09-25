import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// costo_ventas del resumen filtra por la fecha de INSERCIÓN del movimiento (hoy),
// no por la fecha de negocio. Ventana de 3 días alrededor de hoy (<=366 días).
const rangoHoy = { desde: isoDay(Date.now() - 86400000), hasta: isoDay(Date.now() + 86400000) };

describe("Integración HTTP — Ventas: auto-producción de preparaciones", { skip: SKIP }, () => {
    const A = 9301;
    let server, base, pool, signToken;
    let tokAdmin;
    let provId, tomateId, cebollaId, chileId, salsaRecetaId, salsaElabId, chilaqRecetaId;

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

    const stockDe = async (pid) =>
        Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id=$1", [pid])).rows[0].stock_actual);
    const setStock = async (pid, val) =>
        pool.query("UPDATE inventario SET stock_actual=$1 WHERE producto_id=$2", [val, pid]);
    const setMinimo = async (pid, val) =>
        pool.query("UPDATE inventario SET stock_minimo=$1 WHERE producto_id=$2", [val, pid]);

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
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Auto A')", [A]);
        const adminId = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','AU-adm',true,true,$1) RETURNING id", [A])).rows[0].id;
        tokAdmin = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });

        provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        const mkInsumo = async (nombre, cantPres, costoPres) => (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin,
            body: { producto: nombre, unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: cantPres, costo_presentacion: costoPres, stock_actual: 5000, stock_minimo: 100 },
        })).json.data.id;
        // costo_unitario: tomate 0.02, cebolla 0.01, chile 0.05
        tomateId = await mkInsumo("Tomate verde", 1000, 20);
        cebollaId = await mkInsumo("Cebolla", 1000, 10);
        chileId = await mkInsumo("Chile", 1000, 50);

        // Preparación Salsa verde: 1 lote rinde 5000 ml (tomate 2000, cebolla 200, chile 50)
        const salsa = await req("POST", `/api/recetas/${A}`, {
            token: tokAdmin,
            body: {
                nombre: "Salsa Verde", categoria: "Salsas", precio_venta: 0, es_preparacion: true,
                rendimiento: 5000, unidad: "ml", stock_minimo: 500,
                ingredientes: [{ producto_id: tomateId, cantidad: 2000 }, { producto_id: cebollaId, cantidad: 200 }, { producto_id: chileId, cantidad: 50 }],
            },
        });
        salsaRecetaId = salsa.json.data.id;
        salsaElabId = Number((await pool.query("SELECT producto_elaborado_id FROM recetas WHERE id=$1", [salsaRecetaId])).rows[0].producto_elaborado_id);

        // Chilaquiles: 150 ml de salsa por platillo
        chilaqRecetaId = (await req("POST", `/api/recetas/${A}`, {
            token: tokAdmin, body: { nombre: "Chilaquiles", categoria: "Platillos", precio_venta: 90, ingredientes: [{ producto_id: salsaElabId, cantidad: 150 }] },
        })).json.data.id;
        await req("POST", `/api/pos-map/${A}`, { token: tokAdmin, body: { nombre_pos: "Chilaquiles", tipo: "RECETA", receta_id: chilaqRecetaId, factor: 1 } });
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("import auto-produce el faltante de la preparación y descuenta sus insumos", async () => {
        await setStock(salsaElabId, 3500);
        await setStock(tomateId, 5000); await setStock(cebollaId, 5000); await setStock(chileId, 5000);
        const fecha = "2026-10-01";

        const imp = await req("POST", `/api/ventas/${A}/importar`, { token: tokAdmin, body: { fecha, lineas: [{ nombre_pos: "Chilaquiles", cantidad: 40 }] } });
        assert.equal(imp.status, 201);
        const ap = imp.json.data.auto_produccion;
        assert.equal(ap.length, 1);
        assert.equal(ap[0].producto_id, salsaElabId);
        assert.equal(ap[0].cantidad, 2500);
        assert.equal(ap[0].lotes_equivalentes, 0.5);
        const ins = new Map(ap[0].insumos.map((i) => [i.producto_id, i]));
        assert.equal(ins.get(tomateId).cantidad, 1000);
        assert.equal(ins.get(cebollaId).cantidad, 100);
        assert.equal(ins.get(chileId).cantidad, 25);
        assert.equal(ins.get(tomateId).stock_resultante, 4000);

        // Salsa queda en 0 (no negativa); insumos descontados.
        assert.equal(await stockDe(salsaElabId), 0);
        assert.equal(await stockDe(tomateId), 4000);
        assert.equal(await stockDe(cebollaId), 4900);
        assert.equal(await stockDe(chileId), 4975);
        // limpiar el día
        await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdmin });
    });

    it("preview coincide con el import (misma auto_produccion)", async () => {
        await setStock(salsaElabId, 3500);
        await setStock(tomateId, 5000); await setStock(cebollaId, 5000); await setStock(chileId, 5000);
        const body = { lineas: [{ nombre_pos: "Chilaquiles", cantidad: 40 }] };
        const prev = await req("POST", `/api/ventas/${A}/preview`, { token: tokAdmin, body });
        const fecha = "2026-10-02";
        const imp = await req("POST", `/api/ventas/${A}/importar`, { token: tokAdmin, body: { fecha, ...body } });
        assert.deepEqual(prev.json.data.auto_produccion, imp.json.data.auto_produccion, "preview e import idénticos");
        await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdmin });
    });

    it("revertir deja todo exacto y costo_ventas del día = 0", async () => {
        await setStock(salsaElabId, 3500);
        await setStock(tomateId, 5000); await setStock(cebollaId, 5000); await setStock(chileId, 5000);
        const fecha = "2026-10-03";
        await req("POST", `/api/ventas/${A}/importar`, { token: tokAdmin, body: { fecha, lineas: [{ nombre_pos: "Chilaquiles", cantidad: 40 }] } });
        assert.equal((await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdmin })).status, 200);
        // Existencias exactas
        assert.equal(await stockDe(salsaElabId), 3500);
        assert.equal(await stockDe(tomateId), 5000);
        assert.equal(await stockDe(cebollaId), 5000);
        assert.equal(await stockDe(chileId), 5000);
        // costo_ventas = 0 tras revertir (VENTA compensada por DEVOLUCION; PRODUCCION no cuenta)
        const r = await req("GET", `/api/finanzas/${A}/resumen?desde=${rangoHoy.desde}&hasta=${rangoHoy.hasta}`, { token: tokAdmin });
        assert.equal(Number(r.json.data.costo_ventas), 0);
    });

    it("costo_ventas cuenta el costo de la salsa vendida, sin doble contar insumos (test 8)", async () => {
        await setStock(salsaElabId, 3500);
        await setStock(tomateId, 5000); await setStock(cebollaId, 5000); await setStock(chileId, 5000);
        const fecha = "2026-10-04";
        await req("POST", `/api/ventas/${A}/importar`, { token: tokAdmin, body: { fecha, lineas: [{ nombre_pos: "Chilaquiles", cantidad: 40 }] } });
        const salsaCosto = Number((await pool.query("SELECT costo_unitario FROM productos WHERE id=$1", [salsaElabId])).rows[0].costo_unitario);
        const esperado = Number((6000 * salsaCosto).toFixed(2));
        const r = await req("GET", `/api/finanzas/${A}/resumen?desde=${rangoHoy.desde}&hasta=${rangoHoy.hasta}`, { token: tokAdmin });
        assert.equal(Number(r.json.data.costo_ventas), esperado, "costo_ventas = 6000 ml de salsa × su costo");
        await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdmin });
    });

    it("insumo insuficiente: queda negativo, el import no falla e insumos_negativos > 0", async () => {
        await setStock(salsaElabId, 0);
        await setStock(tomateId, 500);
        await setStock(cebollaId, 5000); await setStock(chileId, 5000);
        const fecha = "2026-10-05";
        const imp = await req("POST", `/api/ventas/${A}/importar`, { token: tokAdmin, body: { fecha, lineas: [{ nombre_pos: "Chilaquiles", cantidad: 40 }] } });
        assert.equal(imp.status, 201, "el import no se detiene");
        assert.ok(await stockDe(tomateId) < 0, "el tomate quedó negativo");
        const dias = await req("GET", `/api/ventas/${A}?desde=${fecha}&hasta=${fecha}`, { token: tokAdmin });
        assert.ok(Number(dias.json.data[0].insumos_negativos) > 0, "cuenta el negativo de PRODUCCION");
        await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdmin });
    });

    it("compra_al_producir: no alerta por mínimo y aparece como faltante en sugerencias", async () => {
        // tomate marcado compra_al_producir; stock por debajo del mínimo
        await req("PUT", `/api/productos/${A}/${tomateId}`, { token: tokAdmin, body: { producto: "Tomate verde", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 20, stock_minimo: 100, compra_al_producir: true } });
        await setStock(tomateId, 0);
        await setStock(salsaElabId, 0);
        await setMinimo(salsaElabId, 500);

        // No aparece en alertas ni bajo_minimo
        const alertas = await req("GET", `/api/reportes/${A}/alertas`, { token: tokAdmin });
        assert.equal(alertas.json.data.find((x) => x.producto_id === tomateId), undefined, "compra_al_producir no alerta");
        const inv = await req("GET", `/api/reportes/${A}/inventario`, { token: tokAdmin });
        const filaTomate = inv.json.data.productos.find((x) => x.producto_id === tomateId);
        assert.equal(filaTomate.bajo_minimo, false, "compra_al_producir nunca es bajo_minimo");

        // Sí aparece como faltante en las sugerencias de producción de la salsa
        const sug = await req("GET", `/api/produccion/${A}/sugerencias`, { token: tokAdmin });
        const salsaSug = sug.json.data.find((s) => s.receta_id === salsaRecetaId);
        assert.ok(salsaSug, "la salsa está bajo mínimo -> sugerida");
        const insTomate = salsaSug.insumos.find((i) => i.producto_id === tomateId);
        assert.ok(insTomate, "la sugerencia lista sus insumos");
        assert.equal(insTomate.compra_al_producir, true);
        assert.ok(insTomate.faltante > 0, "marca faltante del insumo");
    });
});
