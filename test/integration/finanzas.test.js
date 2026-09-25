import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — Finanzas", { skip: SKIP }, () => {
    const A = 9201, B = 9202;
    let server, base, pool, signToken;
    let tokAdminA, tokOperA, tokAdminB, operAId;
    let catId, provId, insumoId, recetaId;

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
        await pool.query("DELETE FROM gastos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias_gasto WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM compra WHERE empresa_id = ANY($1)", e);
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
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Fin A'),($2,'Fin B')", [A, B]);
        const mkUser = async (emp, nombre, cod, admin) => (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ($1,$2,$3,$3,$4) RETURNING id",
            [nombre, cod, admin, emp])).rows[0].id;
        const adminAId = await mkUser(A, "AdminA", "FA-adm", true);
        operAId = await mkUser(A, "OperA", "FA-op", false);
        const adminBId = await mkUser(B, "AdminB", "FB-adm", true);
        tokAdminA = signToken({ id: adminAId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        tokOperA = signToken({ id: operAId, empresa_id: A, is_admin: false, is_owner: false, tv: 0 });
        tokAdminB = signToken({ id: adminBId, empresa_id: B, is_admin: true, is_owner: true, tv: 0 });

        // Catálogo base vía API (adminA)
        catId = (await req("POST", `/api/finanzas/${A}/categorias-gasto`, { token: tokAdminA, body: { nombre: "Renta" } })).json.data.id;
        provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Prov F" } })).json.data.id;
        insumoId = (await req("POST", `/api/productos/${A}`, { token: tokAdminA, body: { producto: "Café grano", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 200, stock_actual: 5000, stock_minimo: 100 } })).json.data.id;
        recetaId = (await req("POST", `/api/recetas/${A}`, { token: tokAdminA, body: { nombre: "Café", categoria: "Bebidas", precio_venta: 50, ingredientes: [{ producto_id: insumoId, cantidad: 20 }] } })).json.data.id;
        await req("POST", `/api/pos-map/${A}`, { token: tokAdminA, body: { nombre_pos: "Cafe", tipo: "RECETA", receta_id: recetaId, factor: 1 } });
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("categorías: crear/listar/inactivar; gasto rechaza inactiva y proveedor inactivo", async () => {
        const c = await req("POST", `/api/finanzas/${A}/categorias-gasto`, { token: tokAdminA, body: { nombre: "Temporal" } });
        assert.equal(c.status, 201);
        const tmpId = c.json.data.id;
        await req("PUT", `/api/finanzas/${A}/categorias-gasto/${tmpId}`, { token: tokAdminA, body: { activo: false } });
        const activas = await req("GET", `/api/finanzas/${A}/categorias-gasto`, { token: tokOperA });
        assert.equal(activas.json.data.find((x) => x.id === tmpId), undefined);
        const todas = await req("GET", `/api/finanzas/${A}/categorias-gasto?incluir_inactivas=true`, { token: tokOperA });
        assert.ok(todas.json.data.find((x) => x.id === tmpId));
        // gasto con categoría inactiva -> 400
        const g = await req("POST", `/api/finanzas/${A}/gastos`, { token: tokAdminA, body: { fecha: "2026-09-10", categoria_id: tmpId, concepto: "x", monto: 10, metodo_pago: "EFECTIVO" } });
        assert.equal(g.status, 400);
    });

    it("permisos: Operativo crea y ve solo lo suyo; no edita/anula/resumen/libro", async () => {
        const gOp = await req("POST", `/api/finanzas/${A}/gastos`, { token: tokOperA, body: { fecha: "2026-09-10", categoria_id: catId, concepto: "Gasto oper", monto: 100, metodo_pago: "EFECTIVO" } });
        assert.equal(gOp.status, 201);
        const gAdm = await req("POST", `/api/finanzas/${A}/gastos`, { token: tokAdminA, body: { fecha: "2026-09-10", categoria_id: catId, concepto: "Gasto admin", monto: 200, metodo_pago: "TARJETA" } });
        assert.equal(gAdm.status, 201);
        // Operativo solo ve el suyo
        const listaOp = await req("GET", `/api/finanzas/${A}/gastos`, { token: tokOperA });
        assert.ok(listaOp.json.data.every((x) => x.usuario_id === operAId), "operativo solo ve sus gastos");
        // Admin ve ambos
        const listaAdm = await req("GET", `/api/finanzas/${A}/gastos`, { token: tokAdminA });
        assert.ok(listaAdm.json.data.length >= 2);
        // 403 en editar/anular/resumen/libro
        assert.equal((await req("PUT", `/api/finanzas/${A}/gastos/${gOp.json.data.id}`, { token: tokOperA, body: { fecha: "2026-09-10", categoria_id: catId, concepto: "x", monto: 1, metodo_pago: "EFECTIVO" } })).status, 403);
        assert.equal((await req("POST", `/api/finanzas/${A}/gastos/${gOp.json.data.id}/anular`, { token: tokOperA, body: { motivo: "x" } })).status, 403);
        assert.equal((await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tokOperA })).status, 403);
        assert.equal((await req("GET", `/api/finanzas/${A}/movimientos`, { token: tokOperA })).status, 403);
        // Otra empresa
        assert.equal((await req("GET", `/api/finanzas/${A}/categorias-gasto`, { token: tokAdminB })).status, 403);
    });

    it("ingresos: lote atómico crea varios en una transacción", async () => {
        const lote = await req("POST", `/api/finanzas/${A}/ingresos/lote`, { token: tokOperA, body: { fecha: "2026-09-11", lineas: [{ metodo_pago: "EFECTIVO", monto: 300 }, { metodo_pago: "TARJETA", monto: 450 }, { metodo_pago: "TRANSFERENCIA", monto: 150 }] } });
        assert.equal(lote.status, 201);
        assert.equal(lote.json.data.length, 3);
    });

    it("anular: excluye el gasto de los totales del resumen", async () => {
        const cat = (await req("POST", `/api/finanzas/${A}/categorias-gasto`, { token: tokAdminA, body: { nombre: "AnulCat" } })).json.data.id;
        const g = await req("POST", `/api/finanzas/${A}/gastos`, { token: tokAdminA, body: { fecha: "2026-09-10", categoria_id: cat, concepto: "a anular", monto: 500, metodo_pago: "EFECTIVO" } });
        const antes = await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tokAdminA });
        assert.ok(antes.json.data.gastos.por_categoria.find((x) => x.categoria_id === cat && x.total === 500));
        const anul = await req("POST", `/api/finanzas/${A}/gastos/${g.json.data.id}/anular`, { token: tokAdminA, body: { motivo: "error" } });
        assert.equal(anul.status, 200);
        assert.equal(anul.json.data.anulado, true);
        // Editar un anulado -> 409
        assert.equal((await req("PUT", `/api/finanzas/${A}/gastos/${g.json.data.id}`, { token: tokAdminA, body: { fecha: "2026-09-10", categoria_id: cat, concepto: "x", monto: 1, metodo_pago: "EFECTIVO" } })).status, 409);
        const despues = await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tokAdminA });
        assert.equal(despues.json.data.gastos.por_categoria.find((x) => x.categoria_id === cat), undefined);
    });

    it("libro: las compras aparecen como origen COMPRA", async () => {
        const compra = await req("POST", `/api/compras/${A}`, { token: tokAdminA, body: { proveedor_id: provId, referencia: "FC-9", lineas: [{ producto_id: insumoId, cantidad: 1000, costo_total: 180 }] } });
        assert.equal(compra.status, 201);
        const libro = await req("GET", `/api/finanzas/${A}/movimientos?origen=COMPRA`, { token: tokAdminA });
        const fila = libro.json.data.find((x) => x.origen === "COMPRA" && Number(x.monto) === 180);
        assert.ok(fila, "la compra aparece en el libro");
        assert.equal(fila.categoria, "Compras de insumos");
        assert.equal(fila.metodo_pago, null);
        assert.equal(fila.concepto, "Compra FC-9");
    });

    it("ventas: importar guarda venta_diaria_detalle y revertir lo borra (cascade)", async () => {
        const fecha = "2026-09-12";
        const imp = await req("POST", `/api/ventas/${A}/importar`, { token: tokAdminA, body: { fecha, lineas: [{ nombre_pos: "Cafe", cantidad: 3 }] } });
        assert.equal(imp.status, 201);
        const cnt1 = await pool.query("SELECT COUNT(*)::int c FROM venta_diaria_detalle d JOIN venta_diaria vd ON vd.id=d.venta_diaria_id WHERE vd.empresa_id=$1", [A]);
        assert.ok(cnt1.rows[0].c >= 1, "se guardó el detalle");
        // ingreso esperado = 3 × precio_venta(50) = 150
        const resumen = await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tokAdminA });
        assert.equal(resumen.json.data.ingreso_esperado, 150);
        // revertir borra el detalle por cascade
        assert.equal((await req("DELETE", `/api/ventas/${A}/${fecha}`, { token: tokAdminA })).status, 200);
        const cnt2 = await pool.query("SELECT COUNT(*)::int c FROM venta_diaria_detalle d JOIN venta_diaria vd ON vd.id=d.venta_diaria_id WHERE vd.empresa_id=$1", [A]);
        assert.equal(cnt2.rows[0].c, 0, "el detalle se borró con la reversa");
    });

    it("resumen: ingresos_comparables solo cuenta fechas con detalle", async () => {
        const conDetalle = "2026-09-13";
        const sinDetalle = "2026-09-14";
        await req("POST", `/api/ventas/${A}/importar`, { token: tokAdminA, body: { fecha: conDetalle, lineas: [{ nombre_pos: "Cafe", cantidad: 2 }] } });
        await req("POST", `/api/finanzas/${A}/ingresos`, { token: tokAdminA, body: { fecha: conDetalle, metodo_pago: "EFECTIVO", monto: 100 } });
        await req("POST", `/api/finanzas/${A}/ingresos`, { token: tokAdminA, body: { fecha: sinDetalle, metodo_pago: "EFECTIVO", monto: 999 } });
        const r = await req("GET", `/api/finanzas/${A}/resumen?desde=2026-09-01&hasta=2026-09-30`, { token: tokAdminA });
        assert.equal(r.json.data.ingresos_comparables, 100, "solo cuenta el día con venta importada");
        assert.notEqual(r.json.data.ingreso_esperado, null);
        assert.equal(r.json.data.ingreso_esperado, 100); // 2 × precio_venta(50)
    });

    it("compras: anular revierte stock, sale del libro y 409 si dejaría negativo (2.1)", async () => {
        const s0 = Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id=$1", [insumoId])).rows[0].stock_actual);
        const compra = await req("POST", `/api/compras/${A}`, { token: tokAdminA, body: { proveedor_id: provId, referencia: "ANU-1", lineas: [{ producto_id: insumoId, cantidad: 500, costo_total: 55 }] } });
        assert.equal(compra.status, 201);
        const sMid = Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id=$1", [insumoId])).rows[0].stock_actual);
        assert.equal(sMid, s0 + 500);
        const an = await req("POST", `/api/compras/${A}/${compra.json.data.compra.id}/anular`, { token: tokAdminA, body: { motivo: "capturé mal" } });
        assert.equal(an.status, 200);
        assert.equal(an.json.data.anulado, true);
        const sEnd = Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id=$1", [insumoId])).rows[0].stock_actual);
        assert.equal(sEnd, s0, "stock revertido");
        const libro = await req("GET", `/api/finanzas/${A}/movimientos?origen=COMPRA`, { token: tokAdminA });
        assert.equal(libro.json.data.find((x) => Number(x.monto) === 55), undefined, "la compra anulada no aparece en el libro");
        // Operativo no puede anular
        const c2 = await req("POST", `/api/compras/${A}`, { token: tokAdminA, body: { proveedor_id: provId, referencia: "ANU-2", lineas: [{ producto_id: insumoId, cantidad: 100, costo_total: 20 }] } });
        assert.equal((await req("POST", `/api/compras/${A}/${c2.json.data.compra.id}/anular`, { token: tokOperA, body: { motivo: "x" } })).status, 403);
        // 409 si dejaría negativo
        const p2 = (await req("POST", `/api/productos/${A}`, { token: tokAdminA, body: { producto: "Servilletas", unidad_medida: "pz", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1, costo_presentacion: 1, stock_actual: 0, stock_minimo: 0 } })).json.data.id;
        const c3 = await req("POST", `/api/compras/${A}`, { token: tokAdminA, body: { proveedor_id: provId, referencia: "NEG-1", lineas: [{ producto_id: p2, cantidad: 10, costo_total: 10 }] } });
        await req("POST", `/api/productos/${A}/${p2}/movimientos`, { token: tokAdminA, body: { tipo_movimiento: "AJUSTE", cantidad: -10, motivo: "consumo" } });
        const neg = await req("POST", `/api/compras/${A}/${c3.json.data.compra.id}/anular`, { token: tokAdminA, body: { motivo: "x" } });
        assert.equal(neg.status, 409, "anular que dejaría negativo -> 409");
    });

    it("proveedor: borrado definitivo (409 con historial) y fusionar (2.2)", async () => {
        const libre = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Sin historial" } })).json.data.id;
        assert.equal((await req("DELETE", `/api/proveedores/${A}/${libre}?definitivo=true`, { token: tokAdminA })).status, 200);
        const conHist = await req("DELETE", `/api/proveedores/${A}/${provId}?definitivo=true`, { token: tokAdminA });
        assert.equal(conHist.status, 409);
        assert.ok(conHist.json.details, "devuelve los conteos");
        const malo = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Duplicado" } })).json.data.id;
        const prodMalo = (await req("POST", `/api/productos/${A}`, { token: tokAdminA, body: { producto: "Leche", unidad_medida: "ml", proveedor_id: malo, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 30, stock_actual: 0, stock_minimo: 0 } })).json.data.id;
        const fus = await req("POST", `/api/proveedores/${A}/${malo}/fusionar`, { token: tokAdminA, body: { destino_id: provId } });
        assert.equal(fus.status, 200);
        const prod = await req("GET", `/api/productos/${A}/${prodMalo}`, { token: tokAdminA });
        assert.equal(prod.json.data.proveedor_id, provId, "el producto pasó al proveedor destino");
        const inactivos = await req("GET", `/api/proveedores/${A}?incluir_inactivos=true`, { token: tokAdminA });
        assert.equal(inactivos.json.data.find((x) => x.id === malo).activo, false);
    });

    it("producto: uso devuelve recetas y mapeos POS (2.3)", async () => {
        // Mapeo POS directo al insumo (el sembrado es RECETA, no apunta al producto)
        await req("POST", `/api/pos-map/${A}`, { token: tokAdminA, body: { nombre_pos: "Cafe suelto", tipo: "INSUMO", producto_id: insumoId, factor: 1 } });
        const uso = await req("GET", `/api/productos/${A}/${insumoId}/uso`, { token: tokOperA });
        assert.equal(uso.status, 200);
        assert.ok(uso.json.data.recetas.find((r) => r.id === recetaId), "el insumo aparece en la receta");
        assert.ok(uso.json.data.mapeos_pos.find((m) => m.nombre_pos === "cafe suelto"), "el insumo aparece en el mapeo INSUMO");
    });

    it("proveedor: resumen con compras, totales y último precio (2.4)", async () => {
        const r = await req("GET", `/api/proveedores/${A}/${provId}/resumen`, { token: tokAdminA });
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.json.data.ultimas_compras));
        assert.ok(Number(r.json.data.total_90_dias) > 0);
        assert.ok(r.json.data.ultimo_precio_por_producto.find((x) => x.producto_id === insumoId));
        assert.ok(r.json.data.referencias, "el resumen incluye referencias");
        assert.equal(r.json.data.puede_eliminar, false, "con historial no se puede eliminar");
        assert.ok(r.json.data.referencias.compras > 0);
    });

    it("proveedor: referencias/puede_eliminar coinciden con el borrado definitivo (7b)", async () => {
        // Nuevo sin referencias -> puede_eliminar true y DELETE definitivo 200
        const nuevo = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Nuevo 7b" } })).json.data.id;
        const rn = await req("GET", `/api/proveedores/${A}/${nuevo}/resumen`, { token: tokAdminA });
        assert.equal(rn.json.data.puede_eliminar, true);
        assert.deepEqual(rn.json.data.referencias, { productos: 0, compras: 0, gastos: 0 });
        assert.equal((await req("DELETE", `/api/proveedores/${A}/${nuevo}?definitivo=true`, { token: tokAdminA })).status, 200);

        // Solo una compra anulada -> ultimas_compras vacío, referencias.compras=1, false, DELETE 409
        const cProv = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Solo compra 7b" } })).json.data.id;
        const cc = await req("POST", `/api/compras/${A}`, { token: tokAdminA, body: { proveedor_id: cProv, referencia: "7B-C", lineas: [{ producto_id: insumoId, cantidad: 10, costo_total: 5 }] } });
        await req("POST", `/api/compras/${A}/${cc.json.data.compra.id}/anular`, { token: tokAdminA, body: { motivo: "x" } });
        const rc = await req("GET", `/api/proveedores/${A}/${cProv}/resumen`, { token: tokAdminA });
        assert.equal(rc.json.data.ultimas_compras.length, 0, "la compra anulada no aparece en ultimas_compras");
        assert.equal(rc.json.data.referencias.compras, 1, "pero sí cuenta como referencia");
        assert.equal(rc.json.data.puede_eliminar, false);
        assert.equal((await req("DELETE", `/api/proveedores/${A}/${cProv}?definitivo=true`, { token: tokAdminA })).status, 409);

        // Solo un gasto -> false
        const gProv = (await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Solo gasto 7b" } })).json.data.id;
        await req("POST", `/api/finanzas/${A}/gastos`, { token: tokAdminA, body: { fecha: "2026-09-10", categoria_id: catId, concepto: "g", monto: 10, metodo_pago: "EFECTIVO", proveedor_id: gProv } });
        const rg = await req("GET", `/api/proveedores/${A}/${gProv}/resumen`, { token: tokAdminA });
        assert.equal(rg.json.data.referencias.gastos, 1);
        assert.equal(rg.json.data.puede_eliminar, false);
    });
});
