import pool from "../../config/db.js";

const TIPOS_VALIDOS = ["COMPRA", "VENTA", "MERMA", "AJUSTE", "DEVOLUCION", "PRODUCCION"];

// Dirección del movimiento sobre el stock: 1 suma, -1 resta.
// AJUSTE no tiene dirección fija: el signo de "cantidad" define si suma o resta.
const DIRECCION = {
    COMPRA: 1,
    DEVOLUCION: 1,
    VENTA: -1,
    MERMA: -1,
    PRODUCCION: -1,
    AJUSTE: null,
};

const QUERIES = {
    SELECT_ALL: `
        SELECT
            m.id, m.fecha, m.usuario_id, u.nombre AS usuario, m.producto_id,
            m.tipo_movimiento, m.cantidad, m.costo_unitario,
            m.stock_anterior, m.stock_nuevo, m.motivo, m.referencia_tipo, m.referencia_id
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.producto_id = $1 AND p.empresa_id = $2
        ORDER BY m.fecha DESC, m.id DESC
    `,
    SELECT_PRODUCTO: `SELECT id, costo_unitario FROM productos WHERE id = $1 AND empresa_id = $2`,
    LOCK_INVENTARIO: `SELECT stock_actual FROM inventario WHERE producto_id = $1 FOR UPDATE`,
    UPDATE_STOCK: `UPDATE inventario SET stock_actual = $1, updated_at = CURRENT_TIMESTAMP WHERE producto_id = $2`,
    INSERT_MOVIMIENTO: `
        INSERT INTO movimientosinventario
            (usuario_id, producto_id, tipo_movimiento, cantidad, costo_unitario, stock_anterior, stock_nuevo, motivo, referencia_tipo, referencia_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `,
};

export default class MovimientoRepository {
    async findAll(producto_id, empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [producto_id, empresa_id]);
        return result.rows;
    }

    async registrar(producto_id, empresa_id, data) {
        const {
            tipo_movimiento,
            cantidad,
            motivo = null,
            usuario_id = null,
            costo_unitario = null,
            referencia_tipo = null,
            referencia_id = null,
        } = data;

        if (!TIPOS_VALIDOS.includes(tipo_movimiento)) {
            throw new Error(`tipo_movimiento debe ser uno de: ${TIPOS_VALIDOS.join(", ")}`);
        }
        if (cantidad === undefined || cantidad === null || Number(cantidad) === 0) {
            throw new Error("cantidad es requerida y debe ser distinta de 0");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const productoResult = await client.query(QUERIES.SELECT_PRODUCTO, [
                producto_id,
                empresa_id,
            ]);
            const producto = productoResult.rows[0];
            if (!producto) {
                await client.query("ROLLBACK");
                return null;
            }

            const inventarioResult = await client.query(QUERIES.LOCK_INVENTARIO, [
                producto_id,
            ]);
            const inventario = inventarioResult.rows[0];
            if (!inventario) {
                await client.query("ROLLBACK");
                return null;
            }

            const direccion = DIRECCION[tipo_movimiento];
            const delta =
                direccion === null
                    ? Number(cantidad)
                    : Math.abs(Number(cantidad)) * direccion;

            const stockAnterior = Number(inventario.stock_actual);
            const stockNuevo = stockAnterior + delta;

            if (stockNuevo < 0) {
                throw new Error("Stock insuficiente para este movimiento");
            }

            await client.query(QUERIES.UPDATE_STOCK, [stockNuevo, producto_id]);

            const movimientoResult = await client.query(QUERIES.INSERT_MOVIMIENTO, [
                usuario_id,
                producto_id,
                tipo_movimiento,
                Math.abs(Number(cantidad)),
                costo_unitario ?? producto.costo_unitario,
                stockAnterior,
                stockNuevo,
                motivo,
                referencia_tipo,
                referencia_id,
            ]);

            await client.query("COMMIT");
            return movimientoResult.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
