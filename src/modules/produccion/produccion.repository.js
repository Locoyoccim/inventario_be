import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { normalizarLotes, validarPreparacion, cantidadProducida, cantidadInsumo, calcularSugerencia } from "./produccion.logic.js";
import { netoABruto } from "../../utils/costeo.js";
import { resolverPreparaciones, armarPreparaciones, ordenarPorDependencia } from "../../utils/preparaciones.js";

const QUERIES = {
    // Preparaciones (productos elaborados) con su receta e inventario
    SELECT_ELABORADOS: `
        SELECT r.id AS receta_id, r.nombre, r.rendimiento, r.producto_elaborado_id,
               p.producto, p.unidad_medida, p.costo_unitario,
               i.stock_actual, i.stock_minimo
        FROM recetas r
        JOIN productos p  ON p.id = r.producto_elaborado_id
        JOIN inventario i ON i.producto_id = p.id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true
        ORDER BY r.nombre ASC;`,
    // Escandallo de varias recetas de una vez (evita N+1)
    SELECT_DETALLE_LOTE: `
        SELECT rd.receta_id, rd.producto_id, rd.cantidad, rd.costo_unitario,
               pr.producto, pr.unidad_medida, pr.compra_al_producir, COALESCE(pr.merma_pct,0) AS merma_pct,
               COALESCE(inv.stock_actual, 0) AS stock_actual
        FROM receta_detalle rd
        JOIN productos pr ON pr.id = rd.producto_id
        LEFT JOIN inventario inv ON inv.producto_id = rd.producto_id
        WHERE rd.receta_id = ANY($1);`,
    SELECT_RECETA_PREP: `
        SELECT id, nombre, es_preparacion, rendimiento, producto_elaborado_id
        FROM recetas WHERE id = $1 AND empresa_id = $2;`,
    SELECT_DETALLE_RECETA: `
        SELECT rd.producto_id, rd.cantidad, COALESCE(p.merma_pct,0) AS merma_pct
        FROM receta_detalle rd JOIN productos p ON p.id = rd.producto_id
        WHERE rd.receta_id = $1;`,
    SELECT_PRODUCTO_ELAB: `
        SELECT producto, unidad_medida FROM productos WHERE id = $1;`,
    // Universo completo de la empresa, para resolver la cascada de subrecetas al planificar.
    RECETAS_PREP_EMPRESA: `
        SELECT r.id AS receta_id, r.rendimiento, r.producto_elaborado_id, r.nombre, p.unidad_medida AS unidad
        FROM recetas r
        JOIN productos p ON p.id = r.producto_elaborado_id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true AND r.producto_elaborado_id IS NOT NULL;`,
    RECETA_DETALLE_EMPRESA: `
        SELECT rd.receta_id, rd.producto_id, rd.cantidad
        FROM receta_detalle rd
        JOIN recetas r ON r.id = rd.receta_id
        WHERE r.empresa_id = $1;`,
    PRODUCTOS_INFO_EMPRESA: `
        SELECT id, producto, unidad_medida, COALESCE(merma_pct, 0) AS merma_pct, compra_al_producir
        FROM productos WHERE empresa_id = $1;`,
    STOCK_EMPRESA: `SELECT producto_id, stock_actual FROM inventario WHERE empresa_id = $1;`,
    INSERT_PRODUCCION: `
        INSERT INTO produccion (empresa_id, usuario_id) VALUES ($1, $2) RETURNING id, fecha;`,
    LIST: `
        SELECT pr.id, pr.empresa_id, pr.fecha, pr.usuario_id, u.nombre AS usuario,
               pr.anulado, pr.anulado_at, pr.motivo_anulacion, pr.created_at,
               COALESCE((
                   SELECT STRING_AGG(DISTINCT p.producto, ', ' ORDER BY p.producto)
                   FROM movimientosinventario m JOIN productos p ON p.id = m.producto_id
                   WHERE m.referencia_tipo = 'PRODUCCION' AND m.referencia_id = pr.id AND m.stock_nuevo > m.stock_anterior
               ), '') AS recetas,
               COALESCE((
                   SELECT SUM(m.cantidad * m.costo_unitario)
                   FROM movimientosinventario m
                   WHERE m.referencia_tipo = 'PRODUCCION' AND m.referencia_id = pr.id AND m.stock_nuevo > m.stock_anterior
               ), 0)::numeric(14,2) AS valor,
               COUNT(*) OVER()::int AS total_rows
        FROM produccion pr
        LEFT JOIN usuarios u ON u.id = pr.usuario_id
        WHERE pr.empresa_id = $1
        ORDER BY pr.fecha DESC, pr.id DESC
        LIMIT $2 OFFSET $3;`,
    HEADER_BY_ID: `
        SELECT pr.id, pr.empresa_id, pr.fecha, pr.usuario_id, u.nombre AS usuario,
               pr.anulado, pr.anulado_at, pr.motivo_anulacion, pr.created_at
        FROM produccion pr
        LEFT JOIN usuarios u ON u.id = pr.usuario_id
        WHERE pr.id = $1 AND pr.empresa_id = $2;`,
    FETCH_ANULAR: `SELECT id, anulado FROM produccion WHERE id = $1 AND empresa_id = $2`,
    // Bloquea la cabecera dentro de la transacción: evita doble anulación por dos peticiones casi simultáneas.
    FETCH_ANULAR_LOCK: `SELECT id, anulado FROM produccion WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
    MARK_ANULADA: `
        UPDATE produccion SET anulado = true, anulado_at = now(), anulado_por = $3, motivo_anulacion = $4
        WHERE id = $1 AND empresa_id = $2
        RETURNING id, empresa_id, fecha, usuario_id, anulado, anulado_at, anulado_por, motivo_anulacion, created_at;`,
    LINEAS_BY_PRODUCCION: `
        SELECT m.id AS movimiento_id, m.producto_id, p.producto, p.unidad_medida, m.cantidad, m.costo_unitario,
               m.stock_anterior, m.stock_nuevo, m.motivo,
               (m.stock_nuevo > m.stock_anterior) AS producido
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'PRODUCCION' AND m.referencia_id = $1 AND p.empresa_id = $2
        ORDER BY producido DESC, m.id ASC;`,
    LOCK_INV: `SELECT stock_actual FROM inventario WHERE producto_id = $1 FOR UPDATE`,
};

export default class ProduccionRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    // Sugerencias de producción: preparaciones cuyo stock cayó por debajo del mínimo.
    // Propone lotes enteros hasta reponer al menos el mínimo, y lista los insumos que
    // consumiría cada lote sugerido.
    async sugerencias(empresa_id) {
        const elab = await pool.query(QUERIES.SELECT_ELABORADOS, [empresa_id]);
        const candidatos = elab.rows.filter(
            (r) => Number(r.stock_actual) < Number(r.stock_minimo)
        );
        if (candidatos.length === 0) return [];

        const recetaIds = candidatos.map((r) => Number(r.receta_id));
        const det = await pool.query(QUERIES.SELECT_DETALLE_LOTE, [recetaIds]);
        const detalleByReceta = new Map();
        for (const d of det.rows) {
            const key = Number(d.receta_id);
            if (!detalleByReceta.has(key)) detalleByReceta.set(key, []);
            detalleByReceta.get(key).push(d);
        }

        return candidatos.map((r) => {
            const { rendimiento, faltante, lotes, cantidad_a_producir } =
                calcularSugerencia(r.stock_actual, r.stock_minimo, r.rendimiento);
            const detalleInsumos = detalleByReceta.get(Number(r.receta_id)) || [];
            const insumos_requeridos = detalleInsumos.map((d) => ({
                producto_id: d.producto_id,
                producto: d.producto,
                unidad_medida: d.unidad_medida,
                cantidad_por_lote: Number(d.cantidad),
                cantidad_requerida: cantidadInsumo(d.cantidad, lotes),
            }));
            // Necesidad de insumos para los lotes sugeridos (marca compra_al_producir para el front).
            const insumos = detalleInsumos.map((d) => {
                // Requerido en BRUTO (lo que hay que comprar): neto por lotes / (1 - merma).
                const requerido = netoABruto(cantidadInsumo(d.cantidad, lotes), d.merma_pct);
                const disponible = Number(d.stock_actual);
                const faltante = Number(Math.max(requerido - disponible, 0).toFixed(3));
                return {
                    producto_id: d.producto_id,
                    producto: d.producto,
                    unidad: d.unidad_medida,
                    requerido,
                    disponible,
                    faltante,
                    compra_al_producir: d.compra_al_producir === true,
                };
            });
            return {
                receta_id: r.receta_id,
                producto_elaborado_id: r.producto_elaborado_id,
                nombre: r.nombre,
                unidad: r.unidad_medida,
                rendimiento,
                stock_actual: Number(r.stock_actual),
                stock_minimo: Number(r.stock_minimo),
                faltante,
                lotes_sugeridos: lotes,
                cantidad_a_producir,
                insumos_requeridos,
                insumos,
            };
        });
    }

    // Planifica producir una receta en N lotes: si alguno de sus insumos es a su vez una
    // subreceta (preparación) sin stock suficiente, calcula en cascada (anidamiento arbitrario,
    // con detección de ciclos) cuántos lotes de cada subreceta hay que producir ANTES, y cuánto
    // insumo crudo final falta comprar. Solo lectura: no mueve inventario ni crea registros.
    async planificar(empresa_id, receta_id, lotes) {
        const recRes = await pool.query(QUERIES.SELECT_RECETA_PREP, [receta_id, empresa_id]);
        const receta = recRes.rows[0];
        if (!receta) throw ApiError.notFound(`Receta ${receta_id} no encontrada`);
        validarPreparacion(receta, receta_id);
        const nLotes = normalizarLotes(lotes, receta_id);

        const [detRes, prepRes, detalleEmpresaRes, prodRes, stockRes] = await Promise.all([
            pool.query(QUERIES.SELECT_DETALLE_RECETA, [receta_id]),
            pool.query(QUERIES.RECETAS_PREP_EMPRESA, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE_EMPRESA, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_INFO_EMPRESA, [empresa_id]),
            pool.query(QUERIES.STOCK_EMPRESA, [empresa_id]),
        ]);

        // Demanda directa de la receta objetivo (sus propios insumos, en bruto).
        const consumo = new Map();
        for (const d of detRes.rows) {
            const pid = Number(d.producto_id);
            const bruto = netoABruto(cantidadInsumo(d.cantidad, nLotes), d.merma_pct);
            consumo.set(pid, Number(((consumo.get(pid) ?? 0) + bruto).toFixed(3)));
        }

        const preparaciones = armarPreparaciones(prepRes.rows, detalleEmpresaRes.rows);
        const mermaPorId = new Map(prodRes.rows.map((p) => [Number(p.id), Number(p.merma_pct) || 0]));
        const stockActual = new Map(stockRes.rows.map((s) => [Number(s.producto_id), Number(s.stock_actual)]));
        const prodInfoById = new Map(prodRes.rows.map((p) => [Number(p.id), p]));

        const { consumoFinal, autoProduccion } = resolverPreparaciones(consumo, stockActual, preparaciones, mermaPorId);

        const pasos_previos = ordenarPorDependencia(autoProduccion).map((a) => ({
            receta_id: a.receta_id,
            producto_elaborado_id: a.producto_elaborado_id,
            nombre: a.nombre,
            unidad: a.unidad,
            cantidad_a_producir: a.cantidad,
            lotes: Math.max(1, Math.ceil(a.lotes_equivalentes)),
        }));

        // Insumos crudos (no elaborados): lo que falta comprar una vez cubierta la cascada.
        const insumos = [];
        for (const [pid, cantidadTotal] of consumoFinal.entries()) {
            if (preparaciones.has(pid)) continue;
            const info = prodInfoById.get(pid);
            const disponible = Number(stockActual.get(pid) ?? 0);
            const faltante = Number(Math.max(cantidadTotal - disponible, 0).toFixed(3));
            insumos.push({
                producto_id: pid,
                producto: info?.producto ?? null,
                unidad: info?.unidad_medida ?? null,
                requerido: cantidadTotal,
                disponible,
                faltante,
                compra_al_producir: info?.compra_al_producir === true,
            });
        }

        return {
            receta_id: Number(receta_id),
            nombre: receta.nombre,
            lotes: nLotes,
            cantidad_a_producir: cantidadProducida(receta.rendimiento, nLotes),
            pasos_previos,
            insumos,
        };
    }

    // Confirma una o varias producciones en UNA transacción.
    // producciones: [{ receta_id, lotes }]. Consume insumos (PRODUCCION -) y recibe el
    // producto elaborado (PRODUCCION +). Falla completo si algún insumo no alcanza.
    // Todo el lote queda bajo UN registro de cabecera (produccion.id): todos sus movimientos
    // comparten ese referencia_id, así se puede anular la corrida completa sin tocar otras
    // producciones de las mismas recetas.
    async confirmar(empresa_id, producciones, usuario_id = null) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cab = (await client.query(QUERIES.INSERT_PRODUCCION, [empresa_id, usuario_id])).rows[0];
            const resultados = [];

            for (const { receta_id, lotes, cantidad_real } of producciones) {
                const nLotes = normalizarLotes(lotes, receta_id);

                const recRes = await client.query(QUERIES.SELECT_RECETA_PREP, [receta_id, empresa_id]);
                const receta = recRes.rows[0];
                if (!receta) throw ApiError.notFound(`Receta ${receta_id} no encontrada`);
                validarPreparacion(receta, receta_id);

                const cantProducida = cantidadProducida(receta.rendimiento, nLotes);

                // 1) Consumir insumos del escandallo (PRODUCCION -, estricto: no permite negativo)
                const detRes = await client.query(QUERIES.SELECT_DETALLE_RECETA, [receta_id]);
                const insumosConsumidos = [];
                // Bloqueo en orden por producto_id: evita deadlocks entre producciones concurrentes.
                const detOrden = [...detRes.rows].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
                for (const d of detOrden) {
                    // Descuento en BRUTO (aplica merma de limpieza); validación estricta de existencia.
                    const cantidad = netoABruto(cantidadInsumo(d.cantidad, nLotes), d.merma_pct);
                    const mov = await this.movimientoRepository.aplicar(
                        client,
                        d.producto_id,
                        empresa_id,
                        {
                            tipo_movimiento: "PRODUCCION",
                            cantidad,
                            usuario_id,
                            motivo: `Producción de ${receta.nombre} (${nLotes} lote/s)`,
                            referencia_tipo: "PRODUCCION",
                            referencia_id: cab.id,
                        }
                    );
                    if (!mov) throw ApiError.notFound(`Insumo ${d.producto_id} sin inventario`);
                    insumosConsumidos.push({
                        producto_id: d.producto_id,
                        cantidad,
                        stock_nuevo: Number(mov.stock_nuevo),
                    });
                }

                // 2) Recibir el producto elaborado (PRODUCCION +, dirección forzada)
                const recepcion = await this.movimientoRepository.aplicar(
                    client,
                    receta.producto_elaborado_id,
                    empresa_id,
                    {
                        tipo_movimiento: "PRODUCCION",
                        cantidad: cantProducida,
                        usuario_id,
                        motivo: `Producción de ${receta.nombre} (${nLotes} lote/s)`,
                        referencia_tipo: "PRODUCCION",
                        referencia_id: cab.id,
                    },
                    { direccion: 1 }
                );
                if (!recepcion) throw ApiError.notFound(`Producto elaborado ${receta.producto_elaborado_id} sin inventario`);

                // 3) Rendimiento real vs. teorico: si se peso/conto el lote terminado y difiere de
                // lo que la receta predice, se ajusta la existencia a lo real en el mismo lote (mismo
                // referencia_id), para que anular revierta exactamente lo que de verdad se movio.
                let stockFinal = Number(recepcion.stock_nuevo);
                if (cantidad_real != null && Math.abs(cantidad_real - cantProducida) > 0.0001) {
                    const diferencia = cantidad_real - cantProducida;
                    const ajuste = await this.movimientoRepository.aplicar(
                        client,
                        receta.producto_elaborado_id,
                        empresa_id,
                        {
                            tipo_movimiento: "AJUSTE",
                            cantidad: Math.abs(diferencia),
                            usuario_id,
                            motivo: `Rendimiento real de ${receta.nombre}: ${cantidad_real} vs. ${cantProducida} teorico`,
                            referencia_tipo: "PRODUCCION",
                            referencia_id: cab.id,
                        },
                        { direccion: diferencia > 0 ? 1 : -1 }
                    );
                    if (!ajuste) throw ApiError.notFound(`Producto elaborado ${receta.producto_elaborado_id} sin inventario`);
                    stockFinal = Number(ajuste.stock_nuevo);
                }

                const infoProd = await client.query(QUERIES.SELECT_PRODUCTO_ELAB, [receta.producto_elaborado_id]);
                resultados.push({
                    produccion_id: cab.id,
                    receta_id,
                    nombre: receta.nombre,
                    producto_elaborado_id: receta.producto_elaborado_id,
                    unidad: infoProd.rows[0]?.unidad_medida ?? null,
                    lotes: nLotes,
                    cantidad_producida: cantidad_real ?? cantProducida,
                    cantidad_teorica: cantProducida,
                    stock_elaborado_nuevo: stockFinal,
                    insumos_consumidos: insumosConsumidos,
                });
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

    async findAll(empresa_id, { limit = 50, offset = 0 } = {}) {
        const res = await pool.query(QUERIES.LIST, [empresa_id, limit, offset]);
        const total = res.rows[0]?.total_rows ?? 0;
        return { rows: res.rows.map(({ total_rows, ...r }) => r), total };
    }

    async findById(empresa_id, id) {
        const cab = await pool.query(QUERIES.HEADER_BY_ID, [id, empresa_id]);
        if (!cab.rows[0]) return null;
        const lineas = await pool.query(QUERIES.LINEAS_BY_PRODUCCION, [id, empresa_id]);
        return { ...cab.rows[0], lineas: lineas.rows };
    }

    // Anula el lote completo: revierte cada movimiento (insumos consumidos vuelven, elaborado
    // recibido se descuenta) con un AJUSTE de signo contrario, agregado por producto_id (si el
    // mismo producto aparece varias veces en el lote). 409 si dejaría stock negativo (ej. ya se
    // vendió parte de lo producido).
    async anular(empresa_id, id, usuario_id, motivo) {
        const existe = (await pool.query(QUERIES.FETCH_ANULAR, [id, empresa_id])).rows[0];
        if (!existe) throw ApiError.notFound("Producción no encontrada");

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // Bloquea la cabecera ANTES de decidir si ya está anulada: cierra la ventana en la
            // que dos anulaciones casi simultáneas verían ambas anulado=false.
            const cab = (await client.query(QUERIES.FETCH_ANULAR_LOCK, [id, empresa_id])).rows[0];
            if (!cab) throw ApiError.notFound("Producción no encontrada");
            if (cab.anulado) throw ApiError.conflict("La producción ya está anulada");

            const movs = (await client.query(QUERIES.LINEAS_BY_PRODUCCION, [id, empresa_id])).rows;
            const netoPorProducto = new Map();
            for (const m of movs) {
                const pid = Number(m.producto_id);
                const delta = Number(m.stock_nuevo) - Number(m.stock_anterior);
                netoPorProducto.set(pid, (netoPorProducto.get(pid) ?? 0) + delta);
            }
            const ids = [...netoPorProducto.keys()].sort((a, b) => a - b);

            // 1) Chequeo de stock negativo (bloqueando la fila) — 409 si no alcanza.
            for (const pid of ids) {
                const neto = netoPorProducto.get(pid);
                if (neto === 0) continue;
                const inv = (await client.query(QUERIES.LOCK_INV, [pid])).rows[0];
                const actual = Number(inv?.stock_actual ?? 0);
                if (actual - neto < 0) {
                    throw ApiError.conflict(`Anular dejaría stock negativo en el producto ${pid} (actual ${actual}, a revertir ${neto})`);
                }
            }

            // 2) Reversa: AJUSTE de signo contrario al neto acumulado, por producto.
            for (const pid of ids) {
                const neto = netoPorProducto.get(pid);
                if (neto === 0) continue;
                await this.movimientoRepository.aplicar(client, pid, empresa_id, {
                    tipo_movimiento: "AJUSTE",
                    cantidad: -neto,
                    usuario_id,
                    motivo: "Anulación de producción",
                    referencia_tipo: "PRODUCCION_ANULADA",
                    referencia_id: Number(id),
                });
            }

            // 3) Marcar la producción como anulada.
            const upd = (await client.query(QUERIES.MARK_ANULADA, [id, empresa_id, usuario_id, motivo])).rows[0];
            await client.query("COMMIT");
            return { ...upd, productos_reajustados: ids.length };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
