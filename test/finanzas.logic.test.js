import test from "node:test";
import assert from "node:assert/strict";
import { armarResumen } from "../src/modules/finanzas/finanzas.logic.js";

test("resumen: flujo, resultado, food cost y resta de devoluciones", () => {
    const r = armarResumen({
        periodo: { desde: "2026-09-01", hasta: "2026-09-30" },
        ingresosPorMetodo: [{ metodo_pago: "EFECTIVO", total: "1000" }, { metodo_pago: "TARJETA", total: "500" }],
        gastosPorCategoria: [{ categoria_id: 1, categoria: "Renta", total: "300" }],
        comprasTotal: "400",
        ventaCosto: "600",
        devolucionCosto: "100",
        mermaCosto: "20",
        ingresoEsperado: "1550",
        ingresosComparables: "1200",
        diasSinIngreso: [],
    });
    assert.equal(r.ingresos.total, 1500);
    assert.equal(r.gastos.extra, 300);
    assert.equal(r.gastos.compras, 400);
    assert.equal(r.gastos.total, 700);
    assert.equal(r.flujo, 800); // 1500 - 700
    assert.equal(r.costo_ventas, 500); // 600 - 100 (resta la devolución de reversa)
    assert.equal(r.merma, 20);
    assert.equal(r.resultado_operacion, 700); // 1500 - 500 - 300 (excluye compras)
    assert.equal(r.food_cost_pct, 33.33); // 500/1500*100
    assert.equal(r.ingreso_esperado, 1550);
    assert.equal(r.ingresos_comparables, 1200);
});

test("resumen: food cost null si no hay ingresos; ingreso esperado null", () => {
    const r = armarResumen({
        periodo: {}, ingresosPorMetodo: [], gastosPorCategoria: [], comprasTotal: 0,
        ventaCosto: 0, devolucionCosto: 0, mermaCosto: 0, ingresoEsperado: null, diasSinIngreso: ["2026-09-05"],
    });
    assert.equal(r.ingresos.total, 0);
    assert.equal(r.food_cost_pct, null);
    assert.equal(r.ingreso_esperado, null);
    assert.equal(r.ingresos_comparables, null);
    assert.deepEqual(r.dias_sin_ingreso, ["2026-09-05"]);
});

test("resumen: la serie fusiona las cuatro fuentes por periodo", () => {
    const r = armarResumen({
        periodo: {}, ingresosPorMetodo: [], gastosPorCategoria: [], comprasTotal: 0,
        ventaCosto: 0, devolucionCosto: 0, mermaCosto: 0, ingresoEsperado: null, diasSinIngreso: [],
        serieIngresos: [{ periodo: "2026-09-01", total: "100" }],
        serieCompras: [{ periodo: "2026-09-01", total: "40" }],
        serieGastos: [{ periodo: "2026-09-02", total: "10" }],
        serieCosto: [{ periodo: "2026-09-01", total: "30" }],
    });
    assert.equal(r.serie.length, 2);
    assert.deepEqual(r.serie[0], { periodo: "2026-09-01", ingresos: 100, compras: 40, gastos_extra: 0, costo_ventas: 30, ingresos_neto: 100 });
    assert.deepEqual(r.serie[1], { periodo: "2026-09-02", ingresos: 0, compras: 0, gastos_extra: 10, costo_ventas: 0, ingresos_neto: 0 });
});
