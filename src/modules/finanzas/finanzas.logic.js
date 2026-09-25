// Lógica pura del resumen financiero (sin BD): ensambla las piezas ya agregadas
// por el repositorio y calcula flujo, resultado de operación, food cost y la serie.

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export function armarResumen({
    periodo,
    ivaPct = 0,
    preciosIncluyenIva = true,
    ingresosPorMetodo = [],
    gastosPorCategoria = [],
    comprasTotal = 0,
    ventaCosto = 0,
    devolucionCosto = 0,
    mermaCosto = 0,
    ingresoEsperado = null,
    ingresosComparables = 0,
    diasSinIngreso = [],
    serieIngresos = [],
    serieCompras = [],
    serieGastos = [],
    serieCosto = [],
}) {
    const ingresosTotal = r2(ingresosPorMetodo.reduce((s, x) => s + Number(x.total), 0));
    const ivaFactor = 1 + Number(ivaPct) / 100;
    const ingresosNeto = preciosIncluyenIva && ivaFactor > 0 ? r2(ingresosTotal / ivaFactor) : ingresosTotal;
    const ivaEstimado = r2(ingresosTotal - ingresosNeto);
    const gastosExtra = r2(gastosPorCategoria.reduce((s, x) => s + Number(x.total), 0));
    const compras = r2(comprasTotal);
    const gastosTotal = r2(compras + gastosExtra);
    const costoVentas = r2(Number(ventaCosto) - Number(devolucionCosto));
    const merma = r2(mermaCosto);
    const flujo = r2(ingresosTotal - gastosTotal);
    const resultadoOperacion = r2(ingresosNeto - costoVentas - gastosExtra);
    const foodCostPct = ingresosNeto > 0 ? r2((costoVentas / ingresosNeto) * 100) : null;

    const mapa = new Map();
    const put = (arr, key) => {
        for (const row of arr) {
            const p = String(row.periodo);
            if (!mapa.has(p)) mapa.set(p, { periodo: p, ingresos: 0, compras: 0, gastos_extra: 0, costo_ventas: 0 });
            mapa.get(p)[key] = r2(row.total);
        }
    };
    put(serieIngresos, "ingresos");
    put(serieCompras, "compras");
    put(serieGastos, "gastos_extra");
    put(serieCosto, "costo_ventas");
    const serie = [...mapa.values()]
        .map((row) => ({ ...row, ingresos_neto: preciosIncluyenIva && ivaFactor > 0 ? r2(row.ingresos / ivaFactor) : r2(row.ingresos) }))
        .sort((a, b) => (a.periodo < b.periodo ? -1 : a.periodo > b.periodo ? 1 : 0));

    return {
        periodo,
        ingresos: {
            total: ingresosTotal,
            neto: ingresosNeto,
            iva_estimado: ivaEstimado,
            por_metodo: ingresosPorMetodo.map((x) => ({ metodo_pago: x.metodo_pago, total: r2(x.total) })),
        },
        gastos: {
            compras,
            extra: gastosExtra,
            total: gastosTotal,
            por_categoria: gastosPorCategoria.map((x) => ({ categoria_id: x.categoria_id, categoria: x.categoria, total: r2(x.total) })),
        },
        flujo,
        costo_ventas: costoVentas,
        merma,
        resultado_operacion: resultadoOperacion,
        food_cost_pct: foodCostPct,
        ingreso_esperado: ingresoEsperado == null ? null : r2(ingresoEsperado),
        ingresos_comparables: ingresoEsperado == null ? null : r2(ingresosComparables),
        dias_sin_ingreso: diasSinIngreso,
        serie,
    };
}
