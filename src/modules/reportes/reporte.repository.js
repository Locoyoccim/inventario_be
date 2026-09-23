import pool from "../../config/db.js";

const QUERIES = {
    INVENTARIO: `
        SELECT p.id AS producto_id, p.producto, p.unidad_medida, p.es_elaborado,
               i.stock_actual, i.stock_minimo, p.costo_unitario,
               (i.stock_actual * p.costo_unitario)::numeric(14,2) AS valor,
               (i.stock_actual < i.stock_minimo) AS bajo_minimo
        FROM productos p
        JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $1
        ORDER BY bajo_minimo DESC, p.producto ASC;`,
    ALERTAS: `
        SELECT p.id AS producto_id, p.producto, p.unidad_medida, p.es_elaborado,
               i.stock_actual, i.stock_minimo,
               (i.stock_minimo - i.stock_actual) AS faltante, p.costo_unitario
        FROM productos p
        JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $1 AND i.stock_actual < i.stock_minimo
        ORDER BY (i.stock_minimo - i.stock_actual) DESC;`,
    // Resumen de movimientos por tipo en un rango. valor = magnitud real (|Δstock|) * costo.
    ACTIVIDAD: `
        SELECT m.tipo_movimiento,
               COUNT(*)::int AS num_movimientos,
               COALESCE(SUM(m.cantidad), 0)::numeric(14,3) AS unidades,
               COALESCE(SUM(ABS(m.stock_nuevo - m.stock_anterior) * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND m.fecha::date BETWEEN $2 AND $3
        GROUP BY m.tipo_movimiento
        ORDER BY m.tipo_movimiento;`,
    // Merma real: salidas por MERMA o AJUSTE que redujeron stock.
    MERMA: `
        SELECT COUNT(*)::int AS num,
               COALESCE(SUM((m.stock_anterior - m.stock_nuevo) * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND m.fecha::date BETWEEN $2 AND $3
          AND m.stock_nuevo < m.stock_anterior
          AND m.tipo_movimiento IN ('MERMA', 'AJUSTE');`,
    // Top productos consumidos por VENTA en un rango.
    TOP_CONSUMO: `
        SELECT m.producto_id, p.producto, p.unidad_medida,
               COALESCE(SUM(m.cantidad), 0)::numeric(14,3) AS unidades,
               COALESCE(SUM(m.cantidad * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND m.tipo_movimiento = 'VENTA'
          AND m.fecha::date BETWEEN $2 AND $3
        GROUP BY m.producto_id, p.producto, p.unidad_medida
        ORDER BY valor DESC
        LIMIT $4;`,
};

const num = (v) => Number(v ?? 0);
const accion = (esElaborado) => (esElaborado ? "producir" : "comprar");

export default class ReporteRepository {
    async inventarioValorizado(empresa_id) {
        const res = await pool.query(QUERIES.INVENTARIO, [empresa_id]);
        const productos = res.rows.map((r) => ({
            ...r,
            stock_actual: num(r.stock_actual),
            stock_minimo: num(r.stock_minimo),
            costo_unitario: num(r.costo_unitario),
            valor: num(r.valor),
        }));
        const valor_total = Number(productos.reduce((a, p) => a + p.valor, 0).toFixed(2));
        return {
            productos,
            totales: {
                num_productos: productos.length,
                num_bajo_minimo: productos.filter((p) => p.bajo_minimo).length,
                valor_total_inventario: valor_total,
            },
        };
    }

    async alertas(empresa_id) {
        const res = await pool.query(QUERIES.ALERTAS, [empresa_id]);
        return res.rows.map((r) => ({
            producto_id: r.producto_id,
            producto: r.producto,
            unidad_medida: r.unidad_medida,
            stock_actual: num(r.stock_actual),
            stock_minimo: num(r.stock_minimo),
            faltante: num(r.faltante),
            accion: accion(r.es_elaborado),
        }));
    }

    async actividad(empresa_id, desde, hasta) {
        const [act, merma] = await Promise.all([
            pool.query(QUERIES.ACTIVIDAD, [empresa_id, desde, hasta]),
            pool.query(QUERIES.MERMA, [empresa_id, desde, hasta]),
        ]);
        const por_tipo = act.rows.map((r) => ({
            tipo: r.tipo_movimiento,
            num_movimientos: num(r.num_movimientos),
            unidades: num(r.unidades),
            valor: num(r.valor),
        }));
        return {
            periodo: { desde, hasta },
            por_tipo,
            merma: { num: num(merma.rows[0]?.num), valor: num(merma.rows[0]?.valor) },
        };
    }

    async topConsumo(empresa_id, desde, hasta, limit = 10) {
        const res = await pool.query(QUERIES.TOP_CONSUMO, [empresa_id, desde, hasta, limit]);
        return res.rows.map((r) => ({
            producto_id: r.producto_id,
            producto: r.producto,
            unidad_medida: r.unidad_medida,
            unidades: num(r.unidades),
            valor: num(r.valor),
        }));
    }

    // Estado diario: KPIs de inventario + alertas + actividad del día.
    async estadoDiario(empresa_id, fecha) {
        const [inv, alertas, act] = await Promise.all([
            this.inventarioValorizado(empresa_id),
            this.alertas(empresa_id),
            this.actividad(empresa_id, fecha, fecha),
        ]);
        const porTipo = Object.fromEntries(act.por_tipo.map((t) => [t.tipo, t]));
        const kpi = (tipo) => ({
            num: porTipo[tipo]?.num_movimientos ?? 0,
            unidades: porTipo[tipo]?.unidades ?? 0,
            valor: porTipo[tipo]?.valor ?? 0,
        });
        return {
            fecha,
            inventario: inv.totales,
            alertas,
            actividad_dia: {
                compras: kpi("COMPRA"),
                consumo_ventas: kpi("VENTA"),
                produccion: kpi("PRODUCCION"),
                mermas: act.merma,
            },
        };
    }
}
