import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { normalizarLineaCompra, costoUltimaCompra, costoPresentacionDesde } from "./compra.logic.js";

const QUERIES = {
    INSERT_HEADER: `
        INSERT INTO compra (empresa_id, fecha, proveedor_id, referencia, usuario_id)
        VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5)
        RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at;`,
    // Bloquea inventario y trae datos del producto para el costeo
    LOCK_PRODUCTO: `
        SELECT i.stock_actual, p.costo_unitario, p.cantidad_presentacion, p.es_elaborado, p.producto
        FROM inventario i
        JOIN productos p ON p.id = i.producto_id
        WHERE p.id = $1 AND p.empresa_id = $2
        FOR UPDATE OF i;`,
    // Actualiza el costo manteniendo cantidad_presentacion => costo_unitario = costo_promedio
    UPDATE_COSTO: `
        UPDATE productos SET costo_presentacion = $1
        WHERE id = $2
        RETURNING costo_unitario;`,
    UPDATE_TOTAL: `UPDATE compra SET total = $1 WHERE id = $2 RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at;`,
    LIST: `
        SELECT c.id, c.empresa_id, c.fecha, c.proveedor_id, prov.nombre AS proveedor,
               c.referencia, c.total, c.usuario_id, c.created_at,
               COUNT(*) OVER()::int AS total_rows
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
        WHERE c.empresa_id = $1
        ORDER BY c.fecha DESC, c.id DESC
        LIMIT $2 OFFSET $3;`,
    HEADER_BY_ID: `
        SELECT c.id, c.empresa_id, c.fecha, c.proveedor_id, prov.nombre AS proveedor,
               c.referencia, c.total, c.usuario_id, c.created_at
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
        WHERE c.id = $1 AND c.empresa_id = $2;`,
    LINEAS_BY_COMPRA: `
        SELECT m.producto_id, p.producto, m.cantidad, m.costo_unitario,
               (m.cantidad * m.costo_unitario) AS costo_total,
               m.stock_anterior, m.stock_nuevo
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'COMPRA' AND m.referencia_id = $1
        ORDER BY m.id ASC;`,
};

export default class CompraRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    async findAll(empresa_id, { limit = 50, offset = 0 } = {}) {
        const res = await pool.query(QUERIES.LIST, [empresa_id, limit, offset]);
        const total = res.rows[0]?.total_rows ?? 0;
        return { rows: res.rows.map(({ total_rows, ...r }) => r), total };
    }

    async findById(empresa_id, id) {
        const cab = await pool.query(QUERIES.HEADER_BY_ID, [id, empresa_id]);
        if (!cab.rows[0]) return null;
        const lineas = await pool.query(QUERIES.LINEAS_BY_COMPRA, [id]);
        return { ...cab.rows[0], lineas: lineas.rows };
    }

    // Ingresa una compra: suma stock (COMPRA) y actualiza el costo con promedio ponderado.
    async crear(empresa_id, { fecha = null, proveedor_id = null, referencia = null, usuario_id = null, lineas }) {
        if (!Array.isArray(lineas) || lineas.length === 0) {
            throw ApiError.badRequest("Se requiere al menos una línea en 'lineas'");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_HEADER, [
                empresa_id, fecha, proveedor_id, referencia, usuario_id,
            ])).rows[0];

            const detalle = [];
            let total = 0;
            for (const l of lineas) {
                const producto_id = Number(l.producto_id);
                const { cantidad, costoTotal, precioCompra } = normalizarLineaCompra(l);

                const prodRes = await client.query(QUERIES.LOCK_PRODUCTO, [producto_id, empresa_id]);
                const prod = prodRes.rows[0];
                if (!prod) throw ApiError.badRequest(`El producto ${producto_id} no existe o no tiene inventario en la empresa ${empresa_id}`);
                if (prod.es_elaborado) throw ApiError.badRequest(`El producto ${producto_id} es elaborado: se produce, no se compra`);

                const stockAnterior = Number(prod.stock_actual);
                const costoAnterior = Number(prod.costo_unitario);
                const cantidadPresentacion = Number(prod.cantidad_presentacion) || 1;

                // 1) Suma stock con el precio real de ESTA compra
                const mov = await this.movimientoRepository.aplicar(client, producto_id, empresa_id, {
                    tipo_movimiento: "COMPRA",
                    cantidad,
                    costo_unitario: Number(precioCompra.toFixed(4)),
                    usuario_id,
                    motivo: `Compra${referencia ? " " + referencia : ""}`,
                    referencia_tipo: "COMPRA",
                    referencia_id: cab.id,
                });
                if (!mov) throw ApiError.notFound(`Producto ${producto_id} sin inventario`);

                // 2) Actualiza costo (ÚLTIMO COSTO) y persiste vía costo_presentacion
                const costoNuevoTeorico = costoUltimaCompra(precioCompra);
                const nuevoCostoPresentacion = costoPresentacionDesde(costoNuevoTeorico, cantidadPresentacion);
                const upd = await client.query(QUERIES.UPDATE_COSTO, [nuevoCostoPresentacion, producto_id]);
                const costoNuevo = Number(upd.rows[0].costo_unitario);

                total += costoTotal;
                detalle.push({
                    producto_id,
                    producto: prod.producto,
                    cantidad,
                    precio_compra_unitario: Number(precioCompra.toFixed(4)),
                    costo_total: Number(costoTotal.toFixed(2)),
                    costo_anterior: costoAnterior,
                    costo_nuevo: costoNuevo,
                    stock_anterior: stockAnterior,
                    stock_nuevo: Number(mov.stock_nuevo),
                });
            }

            const cabFinal = (await client.query(QUERIES.UPDATE_TOTAL, [Number(total.toFixed(2)), cab.id])).rows[0];
            await client.query("COMMIT");
            return { compra: cabFinal, lineas: detalle };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
