export const QUERIES = {
    POS_MAP: `SELECT nombre_pos, tipo, receta_id, producto_id, factor FROM pos_map WHERE empresa_id = $1`,
    RECETA_DETALLE: `
        SELECT rd.receta_id, rd.producto_id, rd.cantidad
        FROM receta_detalle rd
        JOIN recetas r ON r.id = rd.receta_id
        WHERE r.empresa_id = $1
    `,
    PRODUCTOS_EMPRESA: `SELECT id, producto, merma_pct FROM productos WHERE empresa_id = $1`,
    VENTA_EXISTE: `SELECT id FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2`,
    RECETAS_PRECIO: `SELECT id, precio_venta FROM recetas WHERE empresa_id = $1`,
    // Productos mapeados como INSUMO (se venden tal cual, sin receta): su precio de venta.
    PRODUCTOS_PRECIO: `SELECT id, precio_venta FROM productos WHERE empresa_id = $1 AND precio_venta IS NOT NULL`,
    // Preparaciones de la empresa: producto elaborado, rendimiento y unidad (para auto-producción).
    RECETAS_PREP: `
        SELECT r.id AS receta_id, r.rendimiento, r.producto_elaborado_id, r.nombre,
               p.unidad_medida AS unidad
        FROM recetas r
        JOIN productos p ON p.id = r.producto_elaborado_id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true AND r.producto_elaborado_id IS NOT NULL
    `,
    STOCK_EMPRESA: `SELECT producto_id, stock_actual FROM inventario WHERE empresa_id = $1`,
    INSERT_DETALLE: `INSERT INTO venta_diaria_detalle (venta_diaria_id, nombre_pos, cantidad, tipo, receta_id, producto_id, precio_unitario) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    INSERT_VENTA: `
        INSERT INTO venta_diaria (empresa_id, fecha, total_lineas, total_unidades)
        VALUES ($1, $2, $3, $4)
        RETURNING id, empresa_id, fecha, total_lineas, total_unidades, procesado_at
    `,
    SELECT_VENTA: `
        SELECT id, empresa_id, fecha, total_lineas, total_unidades, procesado_at
        FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2
    `,
    // Igual que SELECT_VENTA pero bloquea la fila (usar solo dentro de una transacción abierta,
    // en el client ya obtenido) para serializar reversas concurrentes del mismo día.
    SELECT_VENTA_FOR_UPDATE: `
        SELECT id, empresa_id, fecha, total_lineas, total_unidades, procesado_at
        FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2
        FOR UPDATE
    `,
    // Todos los movimientos de una venta (incluye VENTA y PRODUCCION) para reconstruir/revertir.
    MOV_POR_REFERENCIA: `
        SELECT m.producto_id, p.producto, m.tipo_movimiento, m.cantidad, m.costo_unitario,
               m.stock_anterior, m.stock_nuevo
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'VENTA_DIARIA' AND m.referencia_id = $1 AND p.empresa_id = $2
        ORDER BY m.id ASC
    `,
    DELETE_VENTA: `DELETE FROM venta_diaria WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    // Días importados con conteo de productos que quedaron en negativo AL MOMENTO del import
    // (incluye VENTA de insumos/elaborados y PRODUCCION de insumos auto-producidos).
    LIST_DIAS: `
        SELECT vd.id, vd.fecha, vd.total_lineas, vd.total_unidades, vd.procesado_at,
               COALESCE(neg.insumos_negativos, 0) AS insumos_negativos
        FROM venta_diaria vd
        LEFT JOIN (
            SELECT referencia_id, COUNT(DISTINCT producto_id) AS insumos_negativos
            FROM movimientosinventario
            WHERE referencia_tipo = 'VENTA_DIARIA'
              AND tipo_movimiento IN ('VENTA', 'PRODUCCION')
              AND stock_nuevo < 0
            GROUP BY referencia_id
        ) neg ON neg.referencia_id = vd.id
        WHERE vd.empresa_id = $1
          AND ($2::date IS NULL OR vd.fecha >= $2::date)
          AND ($3::date IS NULL OR vd.fecha <= $3::date)
        ORDER BY vd.fecha DESC
    `,
    // Preparaciones (id elaborado -> receta/rendimiento) para reconstruir auto-producción desde movs.
    PREP_INDEX: `
        SELECT r.id AS receta_id, r.rendimiento, r.producto_elaborado_id, r.nombre,
               p.unidad_medida AS unidad
        FROM recetas r
        JOIN productos p ON p.id = r.producto_elaborado_id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true AND r.producto_elaborado_id IS NOT NULL
    `,
    PREP_DETALLE: `
        SELECT rd.receta_id, rd.producto_id
        FROM receta_detalle rd
        JOIN recetas r ON r.id = rd.receta_id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true
    `,
};
