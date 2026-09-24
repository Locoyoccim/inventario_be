import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { validarLineasConteo, resumirVarianza } from "./conteo.logic.js";

const QUERIES = {
    INSERT_HEADER: `
        INSERT INTO conteo_fisico (empresa_id, fecha, usuario_id, motivo, estado)
        VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, 'CERRADO')
        RETURNING id, empresa_id, fecha, usuario_id, motivo, estado, created_at;`,
    // Lee stock teórico y costo, bloqueando la fila de inventario (FOR UPDATE OF i)
    LOCK_PRODUCTO: `
        SELECT i.stock_actual, p.costo_unitario, p.producto, p.unidad_medida
        FROM inventario i
        JOIN productos p ON p.id = i.producto_id
        WHERE p.id = $1 AND p.empresa_id = $2
        FOR UPDATE OF i;`,
    INSERT_DETALLE: `
        INSERT INTO conteo_detalle (conteo_id, producto_id, stock_teorico, stock_fisico, costo_unitario)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, producto_id, stock_teorico, stock_fisico, costo_unitario, variacion, valor_variacion;`,
    UPDATE_HEADER_TOTALS: `
        UPDATE conteo_fisico
        SET total_lineas = $1, valor_variacion_total = $2
        WHERE id = $3
        RETURNING id, empresa_id, fecha, usuario_id, motivo, estado, total_lineas, valor_variacion_total, created_at;`,
    LIST: `
        SELECT id, empresa_id, fecha, usuario_id, motivo, estado, total_lineas, valor_variacion_total, created_at,
               COUNT(*) OVER()::int AS total
        FROM conteo_fisico
        WHERE empresa_id = $1
        ORDER BY fecha DESC, id DESC
        LIMIT $2 OFFSET $3;`,
    HEADER_BY_ID: `
        SELECT id, empresa_id, fecha, usuario_id, motivo, estado, total_lineas, valor_variacion_total, created_at
        FROM conteo_fisico WHERE id = $1 AND empresa_id = $2;`,
    DETALLE_BY_CONTEO: `
        SELECT d.id, d.producto_id, p.producto, p.unidad_medida,
               d.stock_teorico, d.stock_fisico, d.variacion, d.costo_unitario, d.valor_variacion
        FROM conteo_detalle d
        JOIN productos p ON p.id = d.producto_id
        WHERE d.conteo_id = $1
        ORDER BY d.id ASC;`,
    PLANTILLA: `
        SELECT p.id AS producto_id, p.producto, p.unidad_medida, p.es_elaborado,
               i.stock_actual AS stock_teorico
        FROM productos p
        JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $1
        ORDER BY p.producto ASC;`,
};

export default class ConteoRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    // Plantilla para llenar: productos con su stock teórico actual.
    async plantilla(empresa_id) {
        const res = await pool.query(QUERIES.PLANTILLA, [empresa_id]);
        return res.rows.map((r) => ({ ...r, stock_teorico: Number(r.stock_teorico) }));
    }

    async findAll(empresa_id, { limit = 50, offset = 0 } = {}) {
        const res = await pool.query(QUERIES.LIST, [empresa_id, limit, offset]);
        const total = res.rows[0]?.total ?? 0;
        return { rows: res.rows.map(({ total, ...r }) => r), total };
    }

    async findById(empresa_id, id) {
        const cab = await pool.query(QUERIES.HEADER_BY_ID, [id, empresa_id]);
        if (!cab.rows[0]) return null;
        const det = await pool.query(QUERIES.DETALLE_BY_CONTEO, [id]);
        return { ...cab.rows[0], detalle: det.rows };
    }

    // Crea un conteo, calcula varianza vs. teórico y RECONCILIA el inventario a lo
    // físico aplicando AJUSTE por cada línea con diferencia. Todo en una transacción.
    async crear(empresa_id, { fecha = null, usuario_id = null, motivo = null, lineas }) {
        validarLineasConteo(lineas);

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_HEADER, [empresa_id, fecha, usuario_id, motivo])).rows[0];

            const detalle = [];
            // Bloqueo en orden por producto_id: evita deadlocks entre conteos concurrentes.
            const lineasOrden = [...lineas].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
            for (const l of lineasOrden) {
                const producto_id = Number(l.producto_id);
                const stockFisico = Number(l.stock_fisico);
                if (!Number.isFinite(stockFisico) || stockFisico < 0) {
                    throw ApiError.badRequest(`stock_fisico inválido para el producto ${producto_id}`);
                }

                const prodRes = await client.query(QUERIES.LOCK_PRODUCTO, [producto_id, empresa_id]);
                const prod = prodRes.rows[0];
                if (!prod) throw ApiError.badRequest(`El producto ${producto_id} no existe o no tiene inventario en la empresa ${empresa_id}`);

                const stockTeorico = Number(prod.stock_actual);
                const det = (await client.query(QUERIES.INSERT_DETALLE, [
                    cab.id, producto_id, stockTeorico, stockFisico, prod.costo_unitario,
                ])).rows[0];

                const variacion = Number(det.variacion);
                let ajusteAplicado = false;
                let stockNuevo = stockTeorico;
                if (variacion !== 0) {
                    const mov = await this.movimientoRepository.aplicar(client, producto_id, empresa_id, {
                        tipo_movimiento: "AJUSTE",
                        cantidad: variacion, // AJUSTE usa el signo: - merma, + sobrante
                        usuario_id,
                        motivo: `Conteo físico #${cab.id}${motivo ? " - " + motivo : ""}`,
                        referencia_tipo: "CONTEO",
                        referencia_id: cab.id,
                    });
                    if (!mov) throw ApiError.notFound(`Producto ${producto_id} sin inventario`);
                    ajusteAplicado = true;
                    stockNuevo = Number(mov.stock_nuevo);
                }

                detalle.push({
                    ...det,
                    producto: prod.producto,
                    unidad_medida: prod.unidad_medida,
                    stock_teorico: stockTeorico,
                    stock_fisico: stockFisico,
                    variacion,
                    valor_variacion: Number(det.valor_variacion),
                    ajuste_aplicado: ajusteAplicado,
                    stock_nuevo: stockNuevo,
                });
            }

            const resumen = resumirVarianza(detalle);
            const cabFinal = (await client.query(QUERIES.UPDATE_HEADER_TOTALS, [
                resumen.lineas, resumen.valor_neto, cab.id,
            ])).rows[0];

            await client.query("COMMIT");
            return { conteo: cabFinal, detalle, resumen };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
