import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { propagarCostoInsumos } from "../../utils/costeo.js";
import { normalizarLineaCompra, costoUltimaCompra, costoPresentacionDesde } from "./compra.logic.js";

// Mismo umbral que CompraNuevaPage.tsx (UMBRAL_VARIACION_COSTO): a partir de este cambio (%)
// contra el costo actual, se exige confirmación explícita. Reproducido aquí para que no sea
// evitable llamando a la API directo (Postman, integración, futuro cliente móvil).
const UMBRAL_VARIACION_COSTO = 40;

const QUERIES = {
    INSERT_HEADER: `
        INSERT INTO compra (empresa_id, fecha, proveedor_id, referencia, usuario_id, estado)
        VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, COALESCE($6, 'RECIBIDA'))
        RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at, estado;`,
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
    UPDATE_TOTAL: `UPDATE compra SET total = $1 WHERE id = $2 RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at, estado;`,
    LIST_BASE: `
        SELECT c.id, c.empresa_id, c.fecha, c.proveedor_id, prov.nombre AS proveedor,
               c.referencia, c.total, c.usuario_id, c.created_at, c.anulado, c.estado,
               COUNT(*) OVER()::int AS total_rows
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id`,
    HEADER_BY_ID: `
        SELECT c.id, c.empresa_id, c.fecha, c.proveedor_id, prov.nombre AS proveedor,
               c.referencia, c.total, c.usuario_id, c.created_at, c.anulado, c.anulado_at, c.motivo_anulacion, c.estado
        FROM compra c
        LEFT JOIN proveedores prov ON prov.id = c.proveedor_id
        WHERE c.id = $1 AND c.empresa_id = $2;`,
    FETCH_ANULAR: `SELECT id, referencia, anulado, estado FROM compra WHERE id = $1 AND empresa_id = $2`,
    // Bloquea la cabecera dentro de la transacción: sin esto, dos anulaciones casi simultáneas
    // pueden leer anulado=false antes de que la primera haga COMMIT y revertir el stock dos veces.
    FETCH_ANULAR_LOCK: `SELECT id, referencia, anulado, estado FROM compra WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
    // Igual que FETCH_ANULAR_LOCK pero para confirmar recepción: misma necesidad de bloquear la
    // cabecera antes de decidir (dos confirmaciones casi simultáneas no deben duplicar el ingreso).
    FETCH_RECIBIR_LOCK: `SELECT id, referencia, anulado, estado FROM compra WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
    MARK_RECIBIDA: `UPDATE compra SET estado = 'RECIBIDA' WHERE id = $1 AND empresa_id = $2
        RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at, estado;`,
    LOCK_INV: `SELECT stock_actual FROM inventario WHERE producto_id = $1 FOR UPDATE`,
    LAST_COMPRA_MOV: `SELECT m.referencia_id, m.costo_unitario FROM movimientosinventario m
        WHERE m.producto_id = $1 AND m.referencia_tipo = 'COMPRA' ORDER BY m.fecha DESC, m.id DESC LIMIT 2`,
    MARK_ANULADA: `UPDATE compra SET anulado=true, anulado_at=now(), anulado_por=$3, motivo_anulacion=$4
        WHERE id=$1 AND empresa_id=$2
        RETURNING id, empresa_id, fecha, proveedor_id, referencia, total, usuario_id, created_at, anulado, anulado_at, anulado_por, motivo_anulacion, estado`,
    LINEAS_BY_COMPRA: `
        SELECT m.producto_id, p.producto, m.cantidad, m.costo_unitario,
               (m.cantidad * m.costo_unitario) AS costo_total,
               m.stock_anterior, m.stock_nuevo
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'COMPRA' AND m.referencia_id = $1 AND p.empresa_id = $2
        ORDER BY m.id ASC;`,
    // Lineas de un PEDIDO (aun no recibido): no hay movimientos todavia, solo lo que se capturo.
    INSERT_DETALLE: `
        INSERT INTO compra_detalle (compra_id, producto_id, cantidad, costo_unitario)
        VALUES ($1, $2, $3, $4) RETURNING id;`,
    DETALLE_BY_COMPRA: `
        SELECT cd.producto_id, p.producto, cd.cantidad, cd.costo_unitario,
               (cd.cantidad * cd.costo_unitario) AS costo_total
        FROM compra_detalle cd
        JOIN productos p ON p.id = cd.producto_id
        WHERE cd.compra_id = $1
        ORDER BY cd.id ASC;`,
};

export default class CompraRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    async findAll(empresa_id, { limit = 50, offset = 0, proveedor_id, desde, hasta } = {}) {
        const where = ["c.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (proveedor_id) { where.push(`c.proveedor_id = $${i}`); params.push(proveedor_id); i++; }
        if (desde) { where.push(`c.fecha >= $${i}`); params.push(desde); i++; }
        if (hasta) { where.push(`c.fecha <= $${i}`); params.push(hasta); i++; }
        params.push(limit, offset);
        const sql = `${QUERIES.LIST_BASE} WHERE ${where.join(" AND ")} ORDER BY c.fecha DESC, c.id DESC LIMIT $${i} OFFSET $${i + 1};`;
        const res = await pool.query(sql, params);
        const total = res.rows[0]?.total_rows ?? 0;
        return { rows: res.rows.map(({ total_rows, ...r }) => r), total };
    }

    // Anula una compra: revierte el stock (AJUSTE negativo) y, si esta compra fue la última
    // que fijó el costo del producto, restaura el costo anterior. 409 si dejaría stock negativo.
    async anular(empresa_id, id, usuario_id, motivo) {
        const existe = (await pool.query(QUERIES.FETCH_ANULAR, [id, empresa_id])).rows[0];
        if (!existe) throw ApiError.notFound("Compra no encontrada");

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // Bloquea la cabecera ANTES de decidir si ya está anulada: cierra la ventana en la
            // que dos anulaciones casi simultáneas verían ambas anulado=false.
            const cab = (await client.query(QUERIES.FETCH_ANULAR_LOCK, [id, empresa_id])).rows[0];
            if (!cab) throw ApiError.notFound("Compra no encontrada");
            if (cab.anulado) throw ApiError.conflict("La compra ya está anulada");

            // Un PEDIDO nunca tocó inventario ni costo: "anular" aquí es solo cancelarlo.
            if (cab.estado === "PEDIDO") {
                const upd = (await client.query(QUERIES.MARK_ANULADA, [id, empresa_id, usuario_id, motivo])).rows[0];
                await client.query("COMMIT");
                return { ...upd, productos_reajustados: 0, recetas_actualizadas: 0 };
            }

            const lineas = (await client.query(QUERIES.LINEAS_BY_COMPRA, [id, empresa_id])).rows;
            const porProducto = new Map();
            for (const l of lineas) {
                const pid = Number(l.producto_id);
                porProducto.set(pid, (porProducto.get(pid) ?? 0) + Number(l.cantidad));
            }
            const ids = [...porProducto.keys()].sort((a, b) => a - b);

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
        // Un PEDIDO aun no tiene movimientos (no se ha tocado inventario): sus lineas viven en
        // compra_detalle hasta que se confirma la recepción.
        const lineas =
            cab.rows[0].estado === "PEDIDO"
                ? await pool.query(QUERIES.DETALLE_BY_COMPRA, [id])
                : await pool.query(QUERIES.LINEAS_BY_COMPRA, [id, empresa_id]);
        return { ...cab.rows[0], lineas: lineas.rows };
    }

    // Ingresa una compra: suma stock (COMPRA) y actualiza el costo con promedio ponderado.
    async crear(empresa_id, { fecha = null, proveedor_id = null, referencia = null, usuario_id = null, lineas, confirmarCostoAtipico = false }) {
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

        if (!confirmarCostoAtipico) {
            await this.#validarCostoAtipico(pool, empresa_id, lineas.map((l) => ({ producto_id: l.producto_id, precioCompra: normalizarLineaCompra(l).precioCompra })));
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_HEADER, [
                empresa_id, fecha, proveedor_id, referencia, usuario_id, null,
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

    // Reutilizado por crear() y confirmarRecepcion(): mismo umbral, en el mismo momento en que
    // el costo realmente se va a aplicar (al registrar directo, o al confirmar un pedido).
    async #validarCostoAtipico(queryable, empresa_id, lineasConPrecio) {
        const ids = [...new Set(lineasConPrecio.map((l) => Number(l.producto_id)))];
        const prodRes = await queryable.query(
            "SELECT id, producto, costo_unitario FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
            [empresa_id, ids]
        );
        const porId = new Map(prodRes.rows.map((p) => [Number(p.id), p]));
        const atipicas = [];
        for (const l of lineasConPrecio) {
            const prod = porId.get(Number(l.producto_id));
            const actual = Number(prod?.costo_unitario ?? 0);
            if (!prod || !(actual > 0)) continue;
            const variacion = ((l.precioCompra - actual) / actual) * 100;
            if (Math.abs(variacion) >= UMBRAL_VARIACION_COSTO) {
                atipicas.push({ producto_id: prod.id, producto: prod.producto, variacion_pct: Number(variacion.toFixed(1)) });
            }
        }
        if (atipicas.length > 0) {
            throw ApiError.conflict(
                `El costo cambia ${UMBRAL_VARIACION_COSTO}% o más en ${atipicas.length === 1 ? "1 producto" : `${atipicas.length} productos`}: revisa cantidad y costo, o reenvía con confirmarCostoAtipico=true.`,
                { atipicas }
            );
        }
    }

    // Registra un PEDIDO: guarda lineas en compra_detalle, NO toca inventario ni costo. Se
    // confirma despues con confirmarRecepcion(), que recien ahi aplica los movimientos (misma
    // logica que crear(), pero sobre esta cabecera en vez de insertar una nueva).
    async crearPedido(empresa_id, { fecha = null, proveedor_id = null, referencia = null, usuario_id = null, lineas }) {
        if (!Array.isArray(lineas) || lineas.length === 0) {
            throw ApiError.badRequest("Se requiere al menos una línea en 'lineas'");
        }
        if (proveedor_id != null) {
            const prov = await pool.query(
                "SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2",
                [proveedor_id, empresa_id]
            );
            if (prov.rowCount === 0) throw ApiError.badRequest("El proveedor no existe en la empresa");
            if (prov.rows[0].activo === false) throw ApiError.badRequest("El proveedor está inactivo");
        }

        const ids = [...new Set(lineas.map((l) => Number(l.producto_id)))];
        const prodRes = await pool.query(
            "SELECT id, producto, es_elaborado FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
            [empresa_id, ids]
        );
        const porId = new Map(prodRes.rows.map((p) => [Number(p.id), p]));

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_HEADER, [
                empresa_id, fecha, proveedor_id, referencia, usuario_id, "PEDIDO",
            ])).rows[0];

            const detalle = [];
            let total = 0;
            for (const l of lineas) {
                const producto_id = Number(l.producto_id);
                const prod = porId.get(producto_id);
                if (!prod) throw ApiError.badRequest(`El producto ${producto_id} no existe en la empresa ${empresa_id}`);
                if (prod.es_elaborado) throw ApiError.badRequest(`El producto ${producto_id} es elaborado: se produce, no se compra`);

                const { cantidad, costoTotal, precioCompra } = normalizarLineaCompra(l);
                await client.query(QUERIES.INSERT_DETALLE, [cab.id, producto_id, cantidad, Number(precioCompra.toFixed(4))]);
                total += costoTotal;
                detalle.push({ producto_id, producto: prod.producto, cantidad, precio_compra_unitario: Number(precioCompra.toFixed(4)), costo_total: Number(costoTotal.toFixed(2)) });
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

    // Confirma la recepción de un PEDIDO: recien aqui se suma stock y se actualiza costo, con
    // la misma logica/umbral de crear(). 409 si ya estaba recibido o anulado.
    async confirmarRecepcion(empresa_id, id, usuario_id, confirmarCostoAtipico = false) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.FETCH_RECIBIR_LOCK, [id, empresa_id])).rows[0];
            if (!cab) {
                await client.query("ROLLBACK");
                return null;
            }
            if (cab.anulado) throw ApiError.conflict("El pedido está anulado");
            if (cab.estado !== "PEDIDO") throw ApiError.conflict("Esta compra ya fue recibida");

            const lineasPedido = (await client.query(QUERIES.DETALLE_BY_COMPRA, [id])).rows;
            if (lineasPedido.length === 0) throw ApiError.badRequest("El pedido no tiene líneas");

            if (!confirmarCostoAtipico) {
                await this.#validarCostoAtipico(
                    client,
                    empresa_id,
                    lineasPedido.map((l) => ({ producto_id: l.producto_id, precioCompra: Number(l.costo_unitario) }))
                );
            }

            const detalle = [];
            let total = 0;
            // Bloqueo en orden por producto_id: evita deadlocks entre confirmaciones concurrentes.
            const lineasOrden = [...lineasPedido].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
            for (const l of lineasOrden) {
                const producto_id = Number(l.producto_id);
                const cantidad = Number(l.cantidad);
                const precioCompra = Number(l.costo_unitario);
                const costoTotal = cantidad * precioCompra;

                const prodRes = await client.query(QUERIES.LOCK_PRODUCTO, [producto_id, empresa_id]);
                const prod = prodRes.rows[0];
                if (!prod) throw ApiError.notFound(`Producto ${producto_id} sin inventario`);

                const stockAnterior = Number(prod.stock_actual);
                const costoAnterior = Number(prod.costo_unitario);
                const cantidadPresentacion = Number(prod.cantidad_presentacion) || 1;

                const mov = await this.movimientoRepository.aplicar(client, producto_id, empresa_id, {
                    tipo_movimiento: "COMPRA",
                    cantidad,
                    costo_unitario: Number(precioCompra.toFixed(4)),
                    usuario_id,
                    motivo: `Compra${cab.referencia ? " " + cab.referencia : ""}`,
                    referencia_tipo: "COMPRA",
                    referencia_id: id,
                });
                if (!mov) throw ApiError.notFound(`Producto ${producto_id} sin inventario`);

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

            await client.query(QUERIES.UPDATE_TOTAL, [Number(total.toFixed(2)), id]);
            const cabFinal = (await client.query(QUERIES.MARK_RECIBIDA, [id, empresa_id])).rows[0];
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
