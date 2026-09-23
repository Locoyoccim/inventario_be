import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

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
            m.stock_anterior, m.stock_nuevo, m.motivo, m.referencia_tipo, m.referencia_id,
            COUNT(*) OVER()::int AS total
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.producto_id = $1 AND p.empresa_id = $2
        ORDER BY m.fecha DESC, m.id DESC
        LIMIT $3 OFFSET $4
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
    async findAll(producto_id, empresa_id, { limit = 50, offset = 0 } = {}) {
        const result = await pool.query(QUERIES.SELECT_ALL, [producto_id, empresa_id, limit, offset]);
        const total = result.rows[0]?.total ?? 0;
        const rows = result.rows.map(({ total, ...r }) => r);
        return { rows, total };
    }

    // Kardex de toda la empresa con filtros opcionales (producto, tipo, rango de fechas, sentido).
    async findAllEmpresa(empresa_id, { limit = 50, offset = 0, productoId = null, tipo = null, desde = null, hasta = null, sentido = null } = {}) {
        const where = ["p.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (productoId) { where.push(`m.producto_id = $${i}`); params.push(productoId); i++; }
        if (tipo) { where.push(`m.tipo_movimiento = $${i}`); params.push(tipo); i++; }
        if (desde) { where.push(`m.fecha::date >= $${i}`); params.push(desde); i++; }
        if (hasta) { where.push(`m.fecha::date <= $${i}`); params.push(hasta); i++; }
        if (sentido === "entrada") where.push("m.stock_nuevo > m.stock_anterior");
        if (sentido === "salida") where.push("m.stock_nuevo < m.stock_anterior");
        const sql = `
            SELECT m.id, m.fecha, m.usuario_id, u.nombre AS usuario, m.producto_id, p.producto, p.unidad_medida,
                   m.tipo_movimiento, m.cantidad, m.costo_unitario, m.stock_anterior, m.stock_nuevo,
                   m.motivo, m.referencia_tipo, m.referencia_id,
                   COUNT(*) OVER()::int AS total
            FROM movimientosinventario m
            JOIN productos p ON p.id = m.producto_id
            LEFT JOIN usuarios u ON u.id = m.usuario_id
            WHERE ${where.join(" AND ")}
            ORDER BY m.fecha DESC, m.id DESC
            LIMIT $${i} OFFSET $${i + 1}`;
        params.push(limit, offset);
        const result = await pool.query(sql, params);
        const total = result.rows[0]?.total ?? 0;
        return { rows: result.rows.map(({ total, ...r }) => r), total };
    }

    // Núcleo reutilizable: aplica UN movimiento usando un client de transacción YA abierto.
    // No hace BEGIN/COMMIT (lo controla quien llama). Devuelve la fila del movimiento,
    // o null si el producto o su inventario no existen para esa empresa.
    // opts.permitirNegativo=true deja que el stock quede negativo (modo importación diaria).
    async aplicar(client, producto_id, empresa_id, data, opts = {}) {
        const { permitirNegativo = false, direccion: direccionOverride } = opts;
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
            throw ApiError.badRequest(`tipo_movimiento debe ser uno de: ${TIPOS_VALIDOS.join(", ")}`);
        }
        if (cantidad === undefined || cantidad === null || Number(cantidad) === 0) {
            throw ApiError.badRequest("cantidad es requerida y debe ser distinta de 0");
        }

        const productoResult = await client.query(QUERIES.SELECT_PRODUCTO, [
            producto_id,
            empresa_id,
        ]);
        const producto = productoResult.rows[0];
        if (!producto) return null;

        const inventarioResult = await client.query(QUERIES.LOCK_INVENTARIO, [producto_id]);
        const inventario = inventarioResult.rows[0];
        if (!inventario) return null;

        // opts.direccion permite forzar el signo (ej. recepción de producto elaborado
        // en una PRODUCCION, que SUMA en lugar de restar).
        const direccion = direccionOverride !== undefined ? direccionOverride : DIRECCION[tipo_movimiento];
        const delta =
            direccion === null
                ? Number(cantidad)
                : Math.abs(Number(cantidad)) * direccion;

        const stockAnterior = Number(inventario.stock_actual);
        const stockNuevo = stockAnterior + delta;

        if (stockNuevo < 0 && !permitirNegativo) {
            throw ApiError.badRequest("Stock insuficiente para este movimiento");
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

        return movimientoResult.rows[0];
    }

    // Registro individual (comportamiento original): su propia transacción.
    async registrar(producto_id, empresa_id, data) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const movimiento = await this.aplicar(client, producto_id, empresa_id, data);
            if (!movimiento) {
                await client.query("ROLLBACK");
                return null;
            }
            await client.query("COMMIT");
            return movimiento;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // Registro por lote genérico: N movimientos en UNA sola transacción.
    // items: [{ producto_id, tipo_movimiento, cantidad, ... }]
    async registrarLote(empresa_id, items, opts = {}) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const resultados = [];
            for (const item of items) {
                const { producto_id, ...data } = item;
                const mov = await this.aplicar(client, producto_id, empresa_id, data, opts);
                if (!mov) {
                    throw ApiError.notFound(`Producto ${producto_id} no encontrado para la empresa ${empresa_id}`);
                }
                resultados.push(mov);
            }
            await client.query("COMMIT");
            return resultados;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
