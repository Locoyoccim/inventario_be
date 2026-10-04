import pool from "../../config/db.js";

const QUERIES = {
    // Descontinuados (activo=false) sin existencia no aportan nada mostrandose: se ocultan.
    // Los que todavia tienen stock siguen apareciendo (hay que darles salida), el front los
    // marca como "Descontinuado" con el campo activo.
    INVENTARIO: `
        SELECT p.id AS producto_id, p.producto, p.unidad_medida, p.es_elaborado, p.categoria, p.activo,
               i.stock_actual, i.stock_minimo, i.stock_maximo, p.costo_unitario,
               (i.stock_actual * p.costo_unitario)::numeric(14,2) AS valor,
               (i.stock_actual < i.stock_minimo AND p.compra_al_producir = false) AS bajo_minimo
        FROM productos p
        JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $1 AND (p.activo = true OR i.stock_actual <> 0)
        ORDER BY bajo_minimo DESC, p.producto ASC;`,
    ALERTAS: `
        SELECT p.id AS producto_id, p.producto, p.unidad_medida, p.es_elaborado,
               i.stock_actual, i.stock_minimo,
               (i.stock_minimo - i.stock_actual) AS faltante, p.costo_unitario
        FROM productos p
        JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $1 AND i.stock_actual < i.stock_minimo AND p.compra_al_producir = false AND p.activo = true
        ORDER BY (i.stock_minimo - i.stock_actual) DESC;`,
    // Resumen de movimientos por tipo en un rango. valor = magnitud real (|Δstock|) * costo.
    ACTIVIDAD: `
        SELECT m.tipo_movimiento,
               COUNT(*)::int AS num_movimientos,
               COALESCE(SUM(m.cantidad), 0)::numeric(14,3) AS unidades,
               COALESCE(SUM(ABS(m.stock_nuevo - m.stock_anterior) * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND fecha_negocio(m.fecha, (SELECT zona_horaria FROM empresas WHERE id = $1)) BETWEEN $2 AND $3
        GROUP BY m.tipo_movimiento
        ORDER BY m.tipo_movimiento;`,
    // Merma real: salidas por MERMA o AJUSTE que redujeron stock.
    MERMA: `
        SELECT COUNT(*)::int AS num,
               COALESCE(SUM((m.stock_anterior - m.stock_nuevo) * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND fecha_negocio(m.fecha, (SELECT zona_horaria FROM empresas WHERE id = $1)) BETWEEN $2 AND $3
          AND m.stock_nuevo < m.stock_anterior
          AND m.tipo_movimiento IN ('MERMA', 'AJUSTE');`,
    // Historial de actividad: registro + anulacion de compras, conteos y producciones, en un
    // solo feed cronologico. Reutiliza columnas que cada tabla ya guarda (usuario_id/created_at
    // al crear, anulado_por/anulado_at/motivo_anulacion al anular); no requiere tabla nueva.
    HISTORIAL: `
        WITH eventos AS (
            SELECT 'COMPRA'::text AS tipo, c.id, 'registrado'::text AS accion, c.created_at AS en,
                   c.usuario_id, NULL::text AS motivo,
                   COALESCE(prov.nombre, c.referencia, '') AS detalle, c.total::numeric AS monto
            FROM compra c LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
            WHERE c.empresa_id = $1
            UNION ALL
            SELECT 'COMPRA', c.id, 'anulado', c.anulado_at, c.anulado_por, c.motivo_anulacion,
                   COALESCE(prov.nombre, c.referencia, ''), c.total::numeric
            FROM compra c LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
            WHERE c.empresa_id = $1 AND c.anulado = true
            UNION ALL
            SELECT 'CONTEO', co.id, 'registrado', co.created_at, co.usuario_id, NULL::text,
                   COALESCE(co.motivo, ''), co.valor_variacion_total::numeric
            FROM conteo_fisico co WHERE co.empresa_id = $1
            UNION ALL
            SELECT 'CONTEO', co.id, 'anulado', co.anulado_at, co.anulado_por, co.motivo_anulacion,
                   COALESCE(co.motivo, ''), co.valor_variacion_total::numeric
            FROM conteo_fisico co WHERE co.empresa_id = $1 AND co.anulado = true
            UNION ALL
            SELECT 'PRODUCCION', pr.id, 'registrado', pr.created_at, pr.usuario_id, NULL::text,
                   ''::text, NULL::numeric
            FROM produccion pr WHERE pr.empresa_id = $1
            UNION ALL
            SELECT 'PRODUCCION', pr.id, 'anulado', pr.anulado_at, pr.anulado_por, pr.motivo_anulacion,
                   ''::text, NULL::numeric
            FROM produccion pr WHERE pr.empresa_id = $1 AND pr.anulado = true
        )
        SELECT e.tipo, e.id, e.accion, e.en, e.usuario_id, u.nombre AS usuario, e.motivo, e.detalle, e.monto,
               COUNT(*) OVER()::int AS total_rows
        FROM eventos e
        LEFT JOIN usuarios u ON u.id = e.usuario_id
        WHERE e.en IS NOT NULL AND fecha_negocio(e.en, (SELECT zona_horaria FROM empresas WHERE id = $1)) BETWEEN $2 AND $3
        ORDER BY e.en DESC
        LIMIT $4 OFFSET $5;`,
    // Top productos consumidos por VENTA en un rango.
    TOP_CONSUMO: `
        SELECT m.producto_id, p.producto, p.unidad_medida,
               COALESCE(SUM(m.cantidad), 0)::numeric(14,3) AS unidades,
               COALESCE(SUM(m.cantidad * m.costo_unitario), 0)::numeric(14,2) AS valor
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE p.empresa_id = $1 AND m.tipo_movimiento = 'VENTA'
          AND fecha_negocio(m.fecha, (SELECT zona_horaria FROM empresas WHERE id = $1)) BETWEEN $2 AND $3
        GROUP BY m.producto_id, p.producto, p.unidad_medida
        ORDER BY valor DESC
        LIMIT $4;`,
};

const num = (v) => Number(v ?? 0);
// stock_maximo es opcional: null significa "sin capturar", no 0.
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const accion = (esElaborado) => (esElaborado ? "producir" : "comprar");

export default class ReporteRepository {
    async inventarioValorizado(empresa_id) {
        const res = await pool.query(QUERIES.INVENTARIO, [empresa_id]);
        const productos = res.rows.map((r) => ({
            ...r,
            stock_actual: num(r.stock_actual),
            stock_minimo: num(r.stock_minimo),
            stock_maximo: numOrNull(r.stock_maximo),
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

    async historial(empresa_id, { desde, hasta, limit = 50, offset = 0 }) {
        const res = await pool.query(QUERIES.HISTORIAL, [empresa_id, desde, hasta, limit, offset]);
        const total = res.rows[0]?.total_rows ?? 0;
        const rows = res.rows.map((r) => ({
            tipo: r.tipo,
            id: r.id,
            accion: r.accion,
            en: r.en,
            usuario_id: r.usuario_id,
            usuario: r.usuario,
            motivo: r.motivo,
            detalle: r.detalle,
            monto: r.monto === null ? null : num(r.monto),
        }));
        return { rows, total };
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

    // Avance de la puesta en marcha de una empresa nueva: cada paso se deduce de sus datos reales.
    // `requerido` = sin esto no se puede vender; lo demás es recomendable.
    async primerosPasos(empresa_id) {
        const r = (await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM categorias WHERE empresa_id = $1 AND activo)::int AS categorias,
                (SELECT COUNT(*) FROM proveedores WHERE empresa_id = $1 AND activo)::int AS proveedores,
                (SELECT COUNT(*) FROM productos WHERE empresa_id = $1 AND activo AND NOT es_elaborado)::int AS insumos,
                (SELECT COUNT(*) FROM recetas WHERE empresa_id = $1 AND activo AND NOT es_preparacion AND precio_venta > 0)::int AS recetas,
                (SELECT COUNT(*) FROM mesas WHERE empresa_id = $1 AND activo)::int AS mesas,
                (SELECT COUNT(*) FROM impresoras WHERE empresa_id = $1 AND activo)::int AS impresoras,
                (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1)::int AS usuarios,
                (SELECT COUNT(*) FROM pos_cuentas WHERE empresa_id = $1 AND estado = 'PAGADA')::int AS ventas_pos`,
            [empresa_id],
        )).rows[0];
        const pasos = [
            { id: "categorias", hecho: r.categorias > 0, cantidad: r.categorias, requerido: true, ruta: "/categorias" },
            { id: "proveedores", hecho: r.proveedores > 0, cantidad: r.proveedores, requerido: false, ruta: "/proveedores" },
            { id: "insumos", hecho: r.insumos > 0, cantidad: r.insumos, requerido: true, ruta: "/productos" },
            { id: "recetas", hecho: r.recetas > 0, cantidad: r.recetas, requerido: true, ruta: "/recetas" },
            { id: "mesas", hecho: r.mesas > 0, cantidad: r.mesas, requerido: true, ruta: "/pos/configuracion" },
            { id: "impresora", hecho: r.impresoras > 0, cantidad: r.impresoras, requerido: false, ruta: "/pos/configuracion" },
            { id: "equipo", hecho: r.usuarios > 1, cantidad: Math.max(r.usuarios - 1, 0), requerido: false, ruta: "/usuarios" },
            { id: "primera_venta", hecho: r.ventas_pos > 0, cantidad: r.ventas_pos, requerido: false, ruta: "/pos" },
        ];
        return { pasos, listo: pasos.filter((p) => p.requerido).every((p) => p.hecho) };
    }

    // ¿La empresa ya opera con el POS? Si es así, importar el CSV deja de ser una tarea diaria y Inicio lo
    // oculta. Además, las cajas de días anteriores que siguen abiertas: su venta aún no llega a Finanzas.
    async estadoPos(empresa_id, hoy) {
        const [opera, vencidos] = await Promise.all([
            pool.query("SELECT EXISTS (SELECT 1 FROM pos_turnos WHERE empresa_id = $1) AS opera", [empresa_id]),
            pool.query(
                `SELECT t.id, t.fecha_negocio, t.abierto_at, u.nombre AS cajero
                 FROM pos_turnos t JOIN usuarios u ON u.id = t.usuario_id
                 WHERE t.empresa_id = $1 AND t.estado = 'ABIERTO' AND t.fecha_negocio < $2::date
                 ORDER BY t.fecha_negocio, t.id`,
                [empresa_id, hoy],
            ),
        ]);
        return {
            activo: opera.rows[0].opera,
            turnos_sin_cerrar: vencidos.rows.map((t) => ({ id: t.id, fecha_negocio: String(t.fecha_negocio).slice(0, 10), abierto_at: t.abierto_at, cajero: t.cajero })),
        };
    }
}
