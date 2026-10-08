import pool from "../../config/db.js";

const TZ = "(SELECT zona_horaria FROM empresas WHERE id = $1)";

// Renglones cobrados del POS dentro del periodo, con su importe sin IVA ya descontado (descuento o cortesía).
const RENGLONES_COBRADOS = `
    SELECT i.receta_id, i.producto_id, i.cantidad, i.iva_pct, COALESCE(i.precio_incluye_iva, true) AS incluye,
           (i.precio_unitario * i.cantidad - CASE WHEN i.cortesia THEN i.precio_unitario * i.cantidad
                                                  ELSE LEAST(COALESCE(i.descuento, 0), i.precio_unitario * i.cantidad) END)
           / CASE WHEN COALESCE(i.precio_incluye_iva, true) THEN 1 + i.iva_pct / 100 ELSE 1 END AS neto
    FROM pos_cuenta_items i JOIN pos_cuentas c ON c.id = i.cuenta_id
    WHERE c.empresa_id = $1 AND c.estado = 'PAGADA' AND c.fecha_negocio BETWEEN $2 AND $3 AND i.estado <> 'CANCELADO'`;

export default class AnalisisRepository {
    async objetivoFoodCost(empresa_id) {
        const r = await pool.query("SELECT food_cost_objetivo FROM empresas WHERE id = $1", [empresa_id]);
        return Number(r.rows[0]?.food_cost_objetivo) || 30;
    }

    // Ventas del periodo: sin IVA (de los renglones) y con IVA (total de las cuentas).
    async ventas(empresa_id, desde, hasta) {
        const [neto, bruto] = await Promise.all([
            pool.query(`SELECT COALESCE(SUM(neto), 0) AS n FROM (${RENGLONES_COBRADOS}) x`, [empresa_id, desde, hasta]),
            pool.query("SELECT COALESCE(SUM(total), 0) AS n FROM pos_cuentas WHERE empresa_id = $1 AND estado = 'PAGADA' AND fecha_negocio BETWEEN $2 AND $3", [empresa_id, desde, hasta]),
        ]);
        return { neto: Number(neto.rows[0].n), bruto: Number(bruto.rows[0].n) };
    }

    // ---- Ingeniería de menú ----
    async menu(empresa_id, desde, hasta) {
        const vendidos = await pool.query(
            `SELECT x.receta_id, x.producto_id,
                    COALESCE(r.nombre, p.producto) AS nombre, COALESCE(r.categoria, p.categoria) AS categoria,
                    SUM(x.cantidad)::int AS unidades, SUM(x.neto) AS ventas_netas,
                    COALESCE(r.costo_total, p.costo_unitario) AS costo_unitario,
                    COALESCE(r.precio_venta, p.precio_venta) AS precio_actual,
                    MAX(x.iva_pct) AS iva_pct, bool_and(x.incluye) AS precio_incluye_iva
             FROM (${RENGLONES_COBRADOS}) x
             LEFT JOIN recetas r ON r.id = x.receta_id
             LEFT JOIN productos p ON p.id = x.producto_id
             GROUP BY x.receta_id, x.producto_id, r.nombre, p.producto, r.categoria, p.categoria, r.costo_total, p.costo_unitario, r.precio_venta, p.precio_venta`,
            [empresa_id, desde, hasta],
        );
        const sinVentas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta FROM recetas r
             WHERE r.empresa_id = $1 AND r.activo AND NOT r.es_preparacion AND r.precio_venta > 0
               AND NOT EXISTS (SELECT 1 FROM pos_cuenta_items i JOIN pos_cuentas c ON c.id = i.cuenta_id
                               WHERE i.receta_id = r.id AND c.estado = 'PAGADA' AND c.fecha_negocio BETWEEN $2 AND $3 AND i.estado <> 'CANCELADO')
             ORDER BY r.nombre LIMIT 100`,
            [empresa_id, desde, hasta],
        );
        return {
            filas: vendidos.rows.map((f) => ({
                ...f, tipo: f.receta_id ? "RECETA" : "PRODUCTO", id: f.receta_id ?? f.producto_id,
                precio_actual: f.precio_actual === null ? null : Number(f.precio_actual),
            })),
            sinVentas: sinVentas.rows.map((r) => ({ id: r.id, nombre: r.nombre, categoria: r.categoria, precio_venta: Number(r.precio_venta) })),
        };
    }

    // ---- Costo teórico contra real ----
    async consumo(empresa_id, desde, hasta, unidad = "week") {
        const base = `FROM movimientosinventario m JOIN productos p ON p.id = m.producto_id
                      WHERE p.empresa_id = $1 AND fecha_negocio(m.fecha, ${TZ}) BETWEEN $2 AND $3`;
        const esDevolucionVenta = "(m.tipo_movimiento = 'DEVOLUCION' AND m.referencia_tipo IN ('VENTA_DIARIA','POS_CUENTA'))";
        const esConteo = "(m.tipo_movimiento = 'AJUSTE' AND m.referencia_tipo IN ('CONTEO','CONTEO_ANULADO'))";
        const esAjusteManual = "(m.tipo_movimiento = 'AJUSTE' AND COALESCE(m.referencia_tipo, '') NOT IN ('CONTEO','CONTEO_ANULADO','COMPRA_ANULADA'))";
        const [filas, serie, conteos] = await Promise.all([
            pool.query(
                `SELECT m.producto_id, p.producto, p.unidad_medida,
                        COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo_movimiento = 'VENTA'), 0) AS venta_qty,
                        COALESCE(SUM(m.cantidad * m.costo_unitario) FILTER (WHERE m.tipo_movimiento = 'VENTA'), 0) AS venta_valor,
                        COALESCE(SUM(m.cantidad) FILTER (WHERE ${esDevolucionVenta}), 0) AS devol_qty,
                        COALESCE(SUM(m.cantidad * m.costo_unitario) FILTER (WHERE ${esDevolucionVenta}), 0) AS devol_valor,
                        COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo_movimiento = 'MERMA'), 0) AS merma_qty,
                        COALESCE(SUM(m.cantidad * m.costo_unitario) FILTER (WHERE m.tipo_movimiento = 'MERMA'), 0) AS merma_valor,
                        COALESCE(SUM(m.stock_nuevo - m.stock_anterior) FILTER (WHERE ${esConteo}), 0) AS conteo_qty,
                        COALESCE(SUM((m.stock_nuevo - m.stock_anterior) * m.costo_unitario) FILTER (WHERE ${esConteo}), 0) AS conteo_valor,
                        COALESCE(SUM((m.stock_nuevo - m.stock_anterior) * m.costo_unitario) FILTER (WHERE ${esAjusteManual}), 0) AS ajuste_valor
                 ${base}
                 GROUP BY m.producto_id, p.producto, p.unidad_medida
                 HAVING bool_or(m.tipo_movimiento IN ('VENTA','MERMA') OR ${esDevolucionVenta} OR ${esConteo} OR ${esAjusteManual})
                 LIMIT 500`,
                [empresa_id, desde, hasta],
            ),
            pool.query(
                `SELECT to_char(date_trunc('${unidad === "month" ? "month" : "week"}', fecha_negocio(m.fecha, ${TZ})::timestamp), 'YYYY-MM-DD') AS periodo,
                        COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'VENTA' THEN m.cantidad * m.costo_unitario
                                          WHEN ${esDevolucionVenta} THEN -m.cantidad * m.costo_unitario END), 0) AS teorico_valor,
                        COALESCE(SUM(CASE WHEN m.tipo_movimiento = 'MERMA' THEN m.cantidad * m.costo_unitario
                                          WHEN ${esConteo} THEN -(m.stock_nuevo - m.stock_anterior) * m.costo_unitario END), 0) AS perdida_valor
                 ${base} GROUP BY 1 ORDER BY 1`,
                [empresa_id, desde, hasta],
            ),
            pool.query(
                `SELECT d.producto_id, to_char(MAX(c.fecha), 'YYYY-MM-DD') AS ultimo, bool_or(c.fecha BETWEEN $2 AND $3) AS en_periodo
                 FROM conteo_detalle d JOIN conteo_fisico c ON c.id = d.conteo_id
                 WHERE c.empresa_id = $1 AND NOT c.anulado GROUP BY d.producto_id`,
                [empresa_id, desde, hasta],
            ),
        ]);
        return { filas: filas.rows, serie: serie.rows, conteos: conteos.rows };
    }

    // ---- Control de fugas ----
    async fugas(empresa_id, desde, hasta) {
        const [eventos, ventasUsuarios, merma] = await Promise.all([
            pool.query(
                `SELECT a.id, to_char(fecha_negocio(a.created_at, ${TZ}), 'YYYY-MM-DD') AS fecha, a.tipo, a.monto, a.motivo, c.folio,
                        a.solicitado_por, us.nombre AS solicitante, a.autorizado_por, ua.nombre AS autorizador
                 FROM pos_autorizaciones a
                 LEFT JOIN pos_cuentas c ON c.id = a.cuenta_id
                 JOIN usuarios ua ON ua.id = a.autorizado_por
                 LEFT JOIN usuarios us ON us.id = a.solicitado_por
                 WHERE a.empresa_id = $1 AND fecha_negocio(a.created_at, ${TZ}) BETWEEN $2 AND $3
                 ORDER BY a.id DESC LIMIT 5000`,
                [empresa_id, desde, hasta],
            ),
            pool.query(
                `SELECT u.id, COALESCE(SUM(c.total), 0) AS ventas
                 FROM usuarios u JOIN pos_cuentas c ON (c.mesero_id = u.id OR c.cobrada_por = u.id)
                 WHERE c.empresa_id = $1 AND c.estado = 'PAGADA' AND c.fecha_negocio BETWEEN $2 AND $3
                 GROUP BY u.id`,
                [empresa_id, desde, hasta],
            ),
            pool.query(
                `SELECT COALESCE(SUM(m.cantidad * m.costo_unitario), 0) AS valor
                 FROM movimientosinventario m JOIN productos p ON p.id = m.producto_id
                 WHERE p.empresa_id = $1 AND m.tipo_movimiento = 'MERMA' AND m.referencia_tipo = 'POS_MERMA'
                   AND fecha_negocio(m.fecha, ${TZ}) BETWEEN $2 AND $3`,
                [empresa_id, desde, hasta],
            ),
        ]);
        return {
            eventos: eventos.rows.map((e) => ({ ...e, monto: Number(e.monto) })),
            ventasPorUsuario: new Map(ventasUsuarios.rows.map((r) => [r.id, Number(r.ventas)])),
            mermaCancelaciones: Number(merma.rows[0].valor),
        };
    }
}
