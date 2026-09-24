import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { propagarCostoInsumos } from "../../utils/costeo.js";
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
               c.referencia, c.total, c.usuario_id, c.created_at, c.anulado,
               COUNT(*) OVER()::int AS total_rows
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
        WHERE c.empresa_id = $1
        ORDER BY c.fecha DESC, c.id DESC
        LIMIT $2 OFFSET $3;`,
    HEADER_BY_ID: `
        SELECT c.id, c.empresa_id, c.fecha, c.proveedor_id, prov.nombre AS proveedor,
               c.referencia, c.total, c.usuario_id, c.created_at, c.anulado, c.anulado_at, c.motivo_anulacion
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
        WHERE c.id = $1 AND c.empresa_id = $2;`,
    FETCH_ANULAR: `SELECT id, referencia, anulado FROM compra WHERE id = $1 AND empresa_id = $2`,
    LOCK_INV: `SELECT stock_actual FROM inventario WHERE producto_id = $1 FOR UPDATE`,
    LAST_COMPRA_MOV: `SELECT m.referencia_id, m.costo_unitario FROM movimientosinventario m
        WHERE m.producto_id = $1 AND m.referencia_tipo = 'COMPRA' ORDER BY m.fecha DESC, m.id DESC LIMIT 2`,
    MARK_ANULADA: `UPDATE compra SET anulado=true, anulado_at=now(), anulado_por=$3, motivo_anulacion=$4
        WHERE id=$1 AND empresa_id=$2
        RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at, anulado, anulado_at, anulado_por, motivo_anulacion`,
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

    // Anula una compra: revierte el stock (AJUSTE negativo) y, si esta compra fue la última
    // que fijó el costo del producto, restaura el costo anterior. 409 si dejaría stock negativo.
    async anular(empresa_id, id, usuario_id, motivo) {
        const cab = (await pool.query(QUERIES.FETCH_ANULAR, [id, empresa_id])).rows[0];
        if (!cab) throw ApiError.notFound("Compra no encontrada");
        if (cab.anulado) throw ApiError.conflict("La compra ya está anulada");

        const lineas = (await pool.query(QUERIES.LINEAS_BY_COMPRA, [id])).rows;
        const porProducto = new Map();
        for (const l of lineas) {
            const pid = Number(l.producto_id);
            porProducto.set(pid, (porProducto.get(pid) ?? 0) + Number(l.cantidad));
        }
        const ids = [...porProducto.keys()].sort((a, b) => a - b);

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // 1) Chequeo de stock negativo (bloqueando la fila) — 409 si no alcanza.
            for (const pid of ids) {
                const inv = (await client.query(QUERIES.LOCK_INV, [pid])).rows[0];
                const actual = Number(inv?.stock_actual ?? 0);
                if (actual - porProducto.get(pid) < 0) {
                    throw ApiError.conflict(`Anular dejaría stock negativo en el producto ${pid} (actual ${actual}, a revertir ${porProducto.get(pid)})`);
                }
            }

            // 2) Reversa de stock: AJUSTE negativo, en orden por producto_id.
            for (const pid of ids) {
                await this.movimientoRepository.aplicar(client, pid, empresa_id, {
                    tipo_movimiento: "AJUSTE",
                    cantidad: -porProducto.get(pid),
                    usuario_id,
                    motivo: `Anulación de compra${cab.referencia ? " " + cab.referencia : ""}`,
                    referencia_tipo: "COMPRA_ANULADA",
                    referencia_id: Number(id),
                });
            }

            // 3) Restaurar costo solo si esta compra fue la ÚLTIMA que lo actualizó.
            const afectados = [];
            for (const pid of ids) {
                const movs = (await client.query(QUERIES.LAST_COMPRA_MOV, [pid])).rows;
                if (movs.length && Number(movs[0].referencia_id) === Number(id) && movs.length >= 2) {
                    const prev = Number(movs[1].costo_unitario);
                    const prod = (await client.query("SELECT cantidad_presentacion FROM productos WHERE id = $1", [pid])).rows[0];
                    const nuevoCostoPres = Number((prev * Number(prod.cantidad_presentacion)).toFixed(4));
                    await client.query("UPDATE productos SET costo_presentacion = $1 WHERE id = $2", [nuevoCostoPres, pid]);
                    afectados.push(pid);
                }
            }
            if (afectados.length) await propagarCostoInsumos(client, afectados);

            // 4) Marcar la compra como anulada.
            const upd = (await client.query(QUERIES.MARK_ANULADA, [id, empresa_id, usuario_id, motivo])).rows[0];
            await client.query("COMMIT");
            return { ...upd, productos_reajustados: ids.length, recetas_actualizadas: afectados.length };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
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

        // Proveedor (opcional): si viene, debe existir en la empresa y estar activo (B-A3)
        if (proveedor_id != null) {
            const prov = await pool.query(
                "SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2",
                [proveedor_id, empresa_id]
            );
            if (prov.rowCount === 0) throw ApiError.badRequest("El proveedor no existe en la empresa");
            if (prov.rows[0].activo === false) throw ApiError.badRequest("El proveedor está inactivo");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_HEADER, [
                empresa_id, fecha, proveedor_id, referencia, usuario_id,
            ])).rows[0];

            const detalle = [];
            let total = 0;
            // Bloqueo en orden por producto_id: evita deadlocks entre compras concurrentes.
            const lineasOrden = [...lineas].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
            for (const l of lineasOrden) {
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
            // 3) El costo de los insumos cambió: refresca el costeo de las recetas que los usan
            const recetasActualizadas = await propagarCostoInsumos(client, detalle.map((d) => d.producto_id));
            await client.query("COMMIT");
            return { compra: cabFinal, lineas: detalle, recetas_actualizadas: recetasActualizadas.length };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
