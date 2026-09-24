import pool from "../../config/db.js";
import { normalizar } from "../../utils/normalize.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    POS_MAP: `SELECT nombre_pos, tipo, receta_id, producto_id, factor FROM pos_map WHERE empresa_id = $1`,
    RECETA_DETALLE: `
        SELECT rd.receta_id, rd.producto_id, rd.cantidad
        FROM receta_detalle rd
        JOIN recetas r ON r.id = rd.receta_id
        WHERE r.empresa_id = $1
    `,
    PRODUCTOS_EMPRESA: `SELECT id, producto FROM productos WHERE empresa_id = $1`,
    VENTA_EXISTE: `SELECT id FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2`,
    INSERT_VENTA: `
        INSERT INTO venta_diaria (empresa_id, fecha, total_lineas, total_unidades)
        VALUES ($1, $2, $3, $4)
        RETURNING id, empresa_id, fecha, total_lineas, total_unidades, procesado_at
    `,
    SELECT_VENTA: `
        SELECT id, empresa_id, fecha, total_lineas, total_unidades, procesado_at
        FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2
    `,
    MOV_POR_REFERENCIA: `
        SELECT m.producto_id, p.producto, m.tipo_movimiento, m.cantidad, m.stock_nuevo
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'VENTA_DIARIA' AND m.referencia_id = $1
        ORDER BY m.id ASC
    `,
    MOV_VENTA_POR_REFERENCIA: `
        SELECT producto_id, cantidad
        FROM movimientosinventario
        WHERE referencia_tipo = 'VENTA_DIARIA' AND referencia_id = $1 AND tipo_movimiento = 'VENTA'
    `,
    DELETE_VENTA: `DELETE FROM venta_diaria WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    // Días importados con conteo de insumos que quedaron en negativo AL MOMENTO del import.
    LIST_DIAS: `
        SELECT vd.id, vd.fecha, vd.total_lineas, vd.total_unidades, vd.procesado_at,
               COALESCE(neg.insumos_negativos, 0) AS insumos_negativos
        FROM venta_diaria vd
        LEFT JOIN (
            SELECT referencia_id, COUNT(DISTINCT producto_id) AS insumos_negativos
            FROM movimientosinventario
            WHERE referencia_tipo = 'VENTA_DIARIA' AND tipo_movimiento = 'VENTA' AND stock_nuevo < 0
            GROUP BY referencia_id
        ) neg ON neg.referencia_id = vd.id
        WHERE vd.empresa_id = $1
          AND ($2::date IS NULL OR vd.fecha >= $2::date)
          AND ($3::date IS NULL OR vd.fecha <= $3::date)
        ORDER BY vd.fecha DESC
    `,
};

// --- Lógica pura (testeable sin BD) --------------------------------------
// Resuelve las líneas del POS contra el mapeo y explota recetas,
// agregando el consumo total por insumo (producto_id).
export function calcularConsumo(lineas, posMap, recetaDetalle) {
    const mapa = new Map(); // nombre_pos normalizado -> fila de pos_map
    for (const m of posMap) mapa.set(normalizar(m.nombre_pos), m);

    const porReceta = new Map(); // receta_id -> [{producto_id, cantidad}]
    for (const d of recetaDetalle) {
        if (!porReceta.has(d.receta_id)) porReceta.set(d.receta_id, []);
        porReceta.get(d.receta_id).push(d);
    }

    const consumo = new Map(); // producto_id -> cantidad total
    const sin_mapeo = [];
    const ignorados = [];
    const recetas_sin_escandallo = [];

    const sumar = (producto_id, cantidad) => {
        consumo.set(producto_id, (consumo.get(producto_id) ?? 0) + cantidad);
    };

    for (const linea of lineas) {
        const cant = Number(linea.cantidad);
        const m = mapa.get(normalizar(linea.nombre_pos));

        if (!m) {
            sin_mapeo.push({ nombre_pos: linea.nombre_pos, cantidad: cant });
            continue;
        }
        const factor = Number(m.factor ?? 1);

        if (m.tipo === "IGNORAR") {
            ignorados.push({ nombre_pos: linea.nombre_pos, cantidad: cant });
        } else if (m.tipo === "INSUMO") {
            sumar(Number(m.producto_id), cant * factor);
        } else if (m.tipo === "RECETA") {
            const detalles = porReceta.get(Number(m.receta_id)) ?? [];
            if (detalles.length === 0) {
                recetas_sin_escandallo.push({
                    nombre_pos: linea.nombre_pos,
                    receta_id: Number(m.receta_id),
                    cantidad: cant,
                });
                continue;
            }
            for (const d of detalles) {
                sumar(Number(d.producto_id), cant * factor * Number(d.cantidad));
            }
        }
    }

    return { consumo, sin_mapeo, ignorados, recetas_sin_escandallo };
}

// --- Repositorio ----------------------------------------------------------
export default class VentaRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    async importarDia(empresa_id, fecha, lineas, opts = {}) {
        const { permitirNegativo = true } = opts;

        // Lecturas (fuera de transacción; solo lectura)
        const [posMapRes, detalleRes, prodRes, existeRes] = await Promise.all([
            pool.query(QUERIES.POS_MAP, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_EMPRESA, [empresa_id]),
            pool.query(QUERIES.VENTA_EXISTE, [empresa_id, fecha]),
        ]);

        if (existeRes.rows[0]) {
            throw ApiError.conflict(`Ya existe una importación de ventas para ${fecha}. Revierte ese día antes de reimportar.`);
        }

        const { consumo, sin_mapeo, ignorados, recetas_sin_escandallo } = calcularConsumo(
            lineas,
            posMapRes.rows,
            detalleRes.rows,
        );

        // Validar que cada insumo exista en la empresa
        const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
        const errores = [];
        const aDescontar = [];
        for (const [producto_id, cantidad] of consumo.entries()) {
            if (!nombrePorId.has(producto_id)) {
                errores.push({ producto_id, motivo: "El mapeo apunta a un insumo inexistente en la empresa" });
            } else {
                aDescontar.push({ producto_id, cantidad });
            }
        }

        const total_lineas = lineas.length;
        const total_unidades = lineas.reduce((s, l) => s + Number(l.cantidad), 0);

        // Escritura atómica: encabezado + todas las restas en UNA transacción
        const client = await pool.connect();
        const descontado = [];
        const negativos = [];
        try {
            await client.query("BEGIN");

            const ventaRes = await client.query(QUERIES.INSERT_VENTA, [
                empresa_id, fecha, total_lineas, total_unidades,
            ]);
            const venta = ventaRes.rows[0];

            for (const item of aDescontar) {
                const mov = await this.movimientoRepository.aplicar(
                    client,
                    item.producto_id,
                    empresa_id,
                    {
                        tipo_movimiento: "VENTA",
                        cantidad: item.cantidad,
                        motivo: `Venta diaria ${fecha}`,
                        referencia_tipo: "VENTA_DIARIA",
                        referencia_id: venta.id,
                    },
                    { permitirNegativo },
                );
                if (!mov) {
                    // El insumo existe en productos pero no tiene fila en inventario:
                    // no se puede descontar. Se reporta y se sigue con los demás.
                    errores.push({
                        producto_id: item.producto_id,
                        producto: nombrePorId.get(item.producto_id),
                        motivo: "El insumo no tiene fila de inventario",
                    });
                    continue;
                }
                const registro = {
                    producto_id: item.producto_id,
                    producto: nombrePorId.get(item.producto_id),
                    cantidad: item.cantidad,
                    stock_nuevo: Number(mov.stock_nuevo),
                };
                descontado.push(registro);
                if (Number(mov.stock_nuevo) < 0) negativos.push(registro);
            }

            await client.query("COMMIT");

            return {
                venta_diaria: venta,
                total_lineas,
                total_unidades,
                descontado,
                negativos,
                sin_mapeo,
                ignorados,
                recetas_sin_escandallo,
                errores,
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // Lista los días importados (encabezados) con su conteo de insumos en negativo.
    async listarDias(empresa_id, { desde = null, hasta = null } = {}) {
        const res = await pool.query(QUERIES.LIST_DIAS, [empresa_id, desde, hasta]);
        return res.rows;
    }

    // Previsualiza el efecto de un mix de ventas SIN escribir nada (mapeo + consumo).
    async previsualizar(empresa_id, lineas) {
        const [posMapRes, detalleRes, prodRes] = await Promise.all([
            pool.query(QUERIES.POS_MAP, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_EMPRESA, [empresa_id]),
        ]);
        const { consumo, sin_mapeo, ignorados, recetas_sin_escandallo } = calcularConsumo(
            lineas,
            posMapRes.rows,
            detalleRes.rows,
        );
        const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
        const consumoList = [];
        const errores = [];
        for (const [producto_id, cantidad] of consumo.entries()) {
            if (!nombrePorId.has(producto_id)) {
                errores.push({ producto_id, motivo: "El mapeo apunta a un insumo inexistente en la empresa" });
            } else {
                consumoList.push({ producto_id, producto: nombrePorId.get(producto_id), cantidad });
            }
        }
        return {
            total_lineas: lineas.length,
            total_unidades: lineas.reduce((sum, l) => sum + Number(l.cantidad), 0),
            consumo: consumoList,
            sin_mapeo,
            ignorados,
            recetas_sin_escandallo,
            errores,
        };
    }

    async consultarDia(empresa_id, fecha) {
        const ventaRes = await pool.query(QUERIES.SELECT_VENTA, [empresa_id, fecha]);
        const venta = ventaRes.rows[0];
        if (!venta) return null;
        const movs = await pool.query(QUERIES.MOV_POR_REFERENCIA, [venta.id]);
        return { ...venta, movimientos: movs.rows };
    }

    // Revierte un día: registra DEVOLUCION por cada VENTA (recompone stock) y
    // borra el encabezado para permitir reimportar. Los movimientos quedan como auditoría.
    async revertirDia(empresa_id, fecha) {
        const ventaRes = await pool.query(QUERIES.SELECT_VENTA, [empresa_id, fecha]);
        const venta = ventaRes.rows[0];
        if (!venta) return null;

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const movs = await client.query(QUERIES.MOV_VENTA_POR_REFERENCIA, [venta.id]);
            for (const m of movs.rows) {
                await this.movimientoRepository.aplicar(
                    client,
                    m.producto_id,
                    empresa_id,
                    {
                        tipo_movimiento: "DEVOLUCION",
                        cantidad: m.cantidad,
                        motivo: `Reversa venta diaria ${fecha}`,
                        referencia_tipo: "VENTA_DIARIA",
                        referencia_id: venta.id,
                    },
                    { permitirNegativo: true },
                );
            }
            await client.query(QUERIES.DELETE_VENTA, [venta.id, empresa_id]);
            await client.query("COMMIT");
            return { revertidos: movs.rows.length, fecha };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
