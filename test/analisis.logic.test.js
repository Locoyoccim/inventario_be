import { test } from "node:test";
import assert from "node:assert/strict";
import { armarConsumo, armarFugas, clasificarMenu, nivelDesviacion } from "../src/modules/analisis/analisis.logic.js";

// Un artículo con `unidades` vendidas, `margenUnit` de ganancia por unidad y costo `costo` (precio sin IVA = costo + margen).
const art = (id, unidades, margenUnit, costo = 20, extra = {}) => ({
    tipo: "RECETA", id, nombre: `Art ${id}`, categoria: "Platillos", unidades,
    ventas_netas: unidades * (costo + margenUnit), costo_unitario: costo, precio_actual: (costo + margenUnit) * 1.16, iva_pct: 16, precio_incluye_iva: true, ...extra,
});

test("ingeniería de menú: estrella, popular, oportunidad y revisar según popularidad y margen", () => {
    const r = clasificarMenu([art(1, 100, 40), art(2, 100, 10), art(3, 10, 50), art(4, 5, 5)]);
    const clase = (id) => r.items.find((i) => i.id === id).clase;
    assert.equal(clase(1), "estrella");
    assert.equal(clase(2), "popular");
    assert.equal(clase(3), "oportunidad");
    assert.equal(clase(4), "revisar");
    assert.deepEqual(r.por_clase, { estrella: 1, popular: 1, oportunidad: 1, revisar: 1 });
    assert.equal(r.suficiente, true);
    assert.equal(r.referencias.popularidad_minima_pct, 17.5, "70 % de lo que le tocaría a cada uno entre 4");
    assert.equal(r.referencias.margen_unitario_promedio, 25.7, "(4000+1000+500+25)/215");
});

test("ingeniería de menú: un artículo sin costo no se clasifica ni mueve los promedios", () => {
    const r = clasificarMenu([art(1, 100, 40), art(2, 100, 10), art(3, 10, 50), art(4, 5, 5), art(9, 500, 30, 0)]);
    const sin = r.items.find((i) => i.id === 9);
    assert.equal(sin.sin_costo, true);
    assert.equal(sin.clase, null);
    assert.equal(r.totales.sin_costo, 1);
    assert.equal(r.referencias.margen_unitario_promedio, 25.7);
});

test("ingeniería de menú: menos de 4 artículos medibles se marca como insuficiente", () => {
    assert.equal(clasificarMenu([art(1, 10, 10), art(2, 10, 10)]).suficiente, false);
});

test("ingeniería de menú: precio sugerido para llegar al objetivo de costo, solo si hoy se pasa", () => {
    // Costo 40 con objetivo 30 % → neto 133.33; con IVA 16 % → 154.67 → 155. El precio actual es 87.
    const caro = clasificarMenu([art(1, 10, 10, 40, { precio_actual: 87 }), art(2, 10, 10), art(3, 10, 10), art(4, 10, 10)]);
    assert.equal(caro.items.find((i) => i.id === 1).precio_sugerido, 155);
    // Un artículo que ya cumple el objetivo no recibe sugerencia.
    const bien = clasificarMenu([art(1, 10, 10, 10, { precio_actual: 100 }), art(2, 10, 10), art(3, 10, 10), art(4, 10, 10)]);
    assert.equal(bien.items.find((i) => i.id === 1).precio_sugerido, null);
    // Precio sin IVA incluido: no se le suma.
    const sinIva = clasificarMenu([art(1, 10, 10, 30, { precio_actual: 50, precio_incluye_iva: false }), art(2, 10, 10), art(3, 10, 10), art(4, 10, 10)]);
    assert.equal(sinIva.items.find((i) => i.id === 1).precio_sugerido, 100);
});

test("ingeniería de menú: el costo de alimentos del periodo sale de lo vendido", () => {
    const r = clasificarMenu([art(1, 10, 30, 20), art(2, 10, 30, 20)]);
    assert.equal(r.totales.ventas_netas, 1000);
    assert.equal(r.totales.costo, 400);
    assert.equal(r.totales.margen, 600);
    assert.equal(r.totales.food_cost_pct, 40);
});

test("niveles de desviación: sin pérdida todo bien; ≥5 % medio, ≥10 % alto", () => {
    assert.equal(nivelDesviacion(0, 0), "ok");
    assert.equal(nivelDesviacion(null, 0), "ok");
    assert.equal(nivelDesviacion(2, 3), "bajo");
    assert.equal(nivelDesviacion(5, 10), "medio");
    assert.equal(nivelDesviacion(10, 20), "alto");
    assert.equal(nivelDesviacion(null, 8), "sin_ventas");
});

const fila = (id, extra) => ({ producto_id: id, producto: `Insumo ${id}`, unidad_medida: "kg", venta_qty: 0, venta_valor: 0, devol_qty: 0, devol_valor: 0, merma_qty: 0, merma_valor: 0, conteo_qty: 0, conteo_valor: 0, ajuste_qty: 0, ajuste_valor: 0, ...extra });

test("costo teórico vs real: la pérdida suma merma y faltante de conteo, y un sobrante la compensa", () => {
    const r = armarConsumo([
        fila(1, { venta_qty: 100, venta_valor: 1000, merma_qty: 5, merma_valor: 50, conteo_qty: -10, conteo_valor: -100 }), // pérdida 150 sobre 1000 = 15 %
        fila(2, { venta_qty: 50, venta_valor: 500, conteo_qty: 4, conteo_valor: 40 }), // sobrante: pérdida -40
        fila(3, { venta_qty: 40, venta_valor: 400, devol_qty: 10, devol_valor: 100, merma_valor: 15, merma_qty: 1 }), // teórico 300, pérdida 15 = 5 %
    ], { contadosEnPeriodo: new Set([1, 2]), ultimoConteo: new Map([[1, "2026-10-01"]]), ventasNetas: 5000 });
    const i = (id) => r.items.find((x) => x.producto_id === id);
    assert.equal(i(1).perdida_valor, 150);
    assert.equal(i(1).desviacion_pct, 15);
    assert.equal(i(1).nivel, "alto");
    assert.equal(i(2).perdida_valor, -40);
    assert.equal(i(2).nivel, "ok");
    assert.equal(i(3).teorico_valor, 300, "las devoluciones por anulación restan del teórico");
    assert.equal(i(3).nivel, "medio");
    assert.equal(r.items[0].producto_id, 1, "ordenado por pérdida");
    assert.equal(r.totales.teorico_valor, 1800);
    assert.equal(r.totales.perdida_valor, 125);
    assert.equal(r.totales.real_valor, 1925);
    assert.equal(r.totales.teorico_pct_ventas, 36);
    assert.equal(r.totales.real_pct_ventas, 38.5);
    assert.equal(r.totales.alertas_altas, 1);
    assert.equal(r.totales.alertas_medias, 1);
});

test("costo teórico vs real: lo que nunca se cuenta queda marcado sin conteo", () => {
    const r = armarConsumo([fila(1, { venta_valor: 200 }), fila(2, { venta_valor: 300 })], { contadosEnPeriodo: new Set([1]) });
    assert.equal(r.items.find((i) => i.producto_id === 2).contado_en_periodo, false);
    assert.equal(r.totales.sin_conteo_insumos, 1);
    assert.equal(r.totales.sin_conteo_valor, 300);
});

test("costo teórico vs real: sin ventas ni pérdidas no hay porcentajes inventados", () => {
    const r = armarConsumo([], {});
    assert.equal(r.totales.desviacion_pct, null);
    assert.equal(r.totales.real_pct_ventas, null);
    assert.deepEqual(r.items, []);
});

const ev = (id, tipo, monto, solicitado, extra = {}) => ({ id, fecha: "2026-10-01", tipo, monto, motivo: "m", folio: id, solicitado_por: solicitado, solicitante: `U${solicitado}`, autorizado_por: 99, autorizador: "Sup", ...extra });

test("control de fugas: resume por tipo, cuenta solo el dinero real y marca a quien destaca frente a sus ventas", () => {
    const eventos = [
        ev(1, "DESCUENTO", 100, 1), ev(2, "DESCUENTO", 120, 1), ev(3, "CORTESIA", 80, 1), ev(4, "CANCELAR_ITEM", 60, 1), // U1: 360 sobre 3 000 = 12 %
        ev(5, "DESCUENTO", 50, 2), ev(6, "CORTESIA", 40, 2), ev(7, "DESCUENTO", 30, 2), // U2: 120 sobre 6 000 = 2 %
        ev(8, "CORREGIR_PAGO", 500, 2), ev(9, "QUITAR_DESCUENTO", 0, 2), // no son dinero perdido
    ];
    const r = armarFugas(eventos, { ventasPorUsuario: new Map([[1, 3000], [2, 6000]]), ventasTotal: 9000, mermaCancelaciones: 45 });
    assert.equal(r.totales.eventos, 9);
    assert.equal(r.totales.monto, 480, "corregir un pago o quitar un descuento no suman");
    assert.equal(r.totales.pct_ventas, 5.33);
    assert.equal(r.totales.merma_cancelaciones, 45);
    const u = (id) => r.por_usuario.find((x) => x.usuario_id === id);
    assert.equal(u(1).pct_ventas, 12);
    assert.equal(u(1).atipico, true, "12 % es más del doble del 5.33 % general");
    assert.equal(u(2).atipico, false);
    assert.equal(u(2).eventos, 5);
    assert.equal(r.totales.atipicos, 1);
    assert.equal(r.por_usuario[0].usuario_id, 1, "ordenado por monto");
    assert.equal(r.por_tipo.find((t) => t.tipo === "CORREGIR_PAGO").monto, 0);
    assert.equal(r.por_tipo.find((t) => t.tipo === "CORREGIR_PAGO").eventos, 1);
    assert.equal(r.por_autorizador[0].eventos, 9);
    assert.equal(r.recientes[0].monto, 100);
    assert.equal(r.recientes.find((e) => e.tipo === "CORREGIR_PAGO").monto, null);
});

test("control de fugas: con pocos eventos o sin ventas propias nadie se marca atípico", () => {
    const pocos = armarFugas([ev(1, "DESCUENTO", 900, 1), ev(2, "DESCUENTO", 900, 1)], { ventasPorUsuario: new Map([[1, 1000]]), ventasTotal: 100000 });
    assert.equal(pocos.por_usuario[0].atipico, false, "solo 2 eventos");
    const sinVentas = armarFugas([ev(1, "DESCUENTO", 10, 1), ev(2, "DESCUENTO", 10, 1), ev(3, "DESCUENTO", 10, 1)], { ventasTotal: 100 });
    assert.equal(sinVentas.por_usuario[0].pct_ventas, null);
    assert.equal(sinVentas.por_usuario[0].atipico, false);
});

test("control de fugas: una autorización sin solicitante se atribuye a quien la dio", () => {
    const r = armarFugas([ev(1, "CORTESIA", 70, null)], {});
    assert.equal(r.por_usuario[0].usuario_id, 99);
    assert.equal(r.por_usuario[0].nombre, "Sup");
});
