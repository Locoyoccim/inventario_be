import pool from "../../config/db.js";
import { normalizar } from "../../utils/normalize.js";
import ApiError from "../../utils/ApiError.js";

const r3 = (n) => Number(Number(n).toFixed(3));

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
    RECETAS_PRECIO: `SELECT id, precio_venta FROM recetas WHERE empresa_id = $1`,
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
    // Todos los movimientos de una venta (incluye VENTA y PRODUCCION) para reconstruir/revertir.
    MOV_POR_REFERENCIA: `
        SELECT m.producto_id, p.producto, m.tipo_movimiento, m.cantidad, m.costo_unitario,
               m.stock_anterior, m.stock_nuevo
        FROM movimientosinventario m
        JOIN productos p ON p.id = m.producto_id
        WHERE m.referencia_tipo = 'VENTA_DIARIA' AND m.referencia_id = $1
        ORDER BY m.id ASC
    `,
    LOCK_INV: `SELECT producto_id FROM inventario WHERE producto_id = ANY($1::int[]) ORDER BY producto_id FOR UPDATE`,
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

// --- Lógica pura (testeable sin BD) --------------------------------------
// Resuelve las líneas del POS contra el mapeo y explota recetas UN nivel,
// agregando el consumo total por insumo/elaborado (producto_id).
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

// Resuelve preparaciones: cuando el consumo de un elaborado supera su stock, calcula
// la auto-producción del faltante desde sus insumos (recursivo, con tope de profundidad
// y detección de ciclos). NO altera el consumo VENTA de los elaborados; devuelve el
// consumo propagado a insumos (consumoFinal) y la lista de auto-producciones.
//   consumo:       Map(producto_id -> cantidad)   (salida de calcularConsumo)
//   stockActual:   Map(producto_id -> stock)
//   preparaciones: Map(producto_elaborado_id -> { receta_id, rendimiento, nombre, unidad, detalle:[{producto_id, cantidad}] })
export function resolverPreparaciones(consumo, stockActual, preparaciones, maxDepth = 5) {
    const consumoFinal = new Map(consumo);
    const producido = new Map();    // elaboradoId -> total auto-producido
    const insumosAcum = new Map();  // elaboradoId -> Map(insumoId -> cantidad)

    const maxIter = maxDepth + 2; // margen para confirmar convergencia (DAG); un ciclo no converge
    let cambio = true;
    let iter = 0;
    while (cambio && iter < maxIter) {
        cambio = false;
        iter++;
        for (const [elabId, prep] of preparaciones.entries()) {
            const consumoTotal = consumoFinal.get(elabId);
            if (consumoTotal === undefined) continue;
            const disponible = Math.max(Number(stockActual.get(elabId) ?? 0), 0) + (producido.get(elabId) ?? 0);
            const faltante = r3(consumoTotal - disponible);
            if (faltante <= 1e-9) continue;
            const rendimiento = Number(prep.rendimiento) || 1;
            producido.set(elabId, r3((producido.get(elabId) ?? 0) + faltante));
            if (!insumosAcum.has(elabId)) insumosAcum.set(elabId, new Map());
            const acum = insumosAcum.get(elabId);
            for (const d of prep.detalle) {
                const add = r3((faltante * Number(d.cantidad)) / rendimiento);
                const pid = Number(d.producto_id);
                consumoFinal.set(pid, r3((consumoFinal.get(pid) ?? 0) + add));
                acum.set(pid, r3((acum.get(pid) ?? 0) + add));
            }
            cambio = true;
        }
    }
    if (cambio) {
        throw ApiError.badRequest(
            "No se pudo resolver la auto-producción: posible ciclo entre preparaciones o anidamiento mayor a 5 niveles"
        );
    }

    const autoProduccion = [];
    for (const [elabId, cantidad] of producido.entries()) {
        const prep = preparaciones.get(elabId);
        const rendimiento = Number(prep.rendimiento) || 1;
        const acum = insumosAcum.get(elabId) ?? new Map();
        autoProduccion.push({
            producto_elaborado_id: elabId,
            receta_id: prep.receta_id,
            nombre: prep.nombre,
            unidad: prep.unidad,
            cantidad,
            lotes_equivalentes: r3(cantidad / rendimiento),
            insumos: [...acum.entries()].map(([producto_id, c]) => ({ producto_id, cantidad: c })),
        });
    }
    return { consumoFinal, autoProduccion };
}

// Construye el Map de preparaciones a partir de las recetas-preparación y el escandallo.
function armarPreparaciones(prepRows, detalleRows) {
    const detalleByReceta = new Map();
    for (const d of detalleRows) {
        const k = Number(d.receta_id);
        if (!detalleByReceta.has(k)) detalleByReceta.set(k, []);
        detalleByReceta.get(k).push({ producto_id: Number(d.producto_id), cantidad: Number(d.cantidad) });
    }
    const prep = new Map();
    for (const r of prepRows) {
        prep.set(Number(r.producto_elaborado_id), {
            receta_id: Number(r.receta_id),
            rendimiento: Number(r.rendimiento) || 1,
            nombre: r.nombre,
            unidad: r.unidad,
            detalle: detalleByReceta.get(Number(r.receta_id)) ?? [],
        });
    }
    return prep;
}

// --- Repositorio ----------------------------------------------------------
export default class VentaRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    async importarDia(empresa_id, fecha, lineas, opts = {}) {
        const { permitirNegativo = true } = opts;

        const [posMapRes, detalleRes, prodRes, existeRes, recetasPrecioRes, prepRes, stockRes] = await Promise.all([
            pool.query(QUERIES.POS_MAP, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_EMPRESA, [empresa_id]),
            pool.query(QUERIES.VENTA_EXISTE, [empresa_id, fecha]),
            pool.query(QUERIES.RECETAS_PRECIO, [empresa_id]),
            pool.query(QUERIES.RECETAS_PREP, [empresa_id]),
            pool.query(QUERIES.STOCK_EMPRESA, [empresa_id]),
        ]);

        if (existeRes.rows[0]) {
            throw ApiError.conflict(`Ya existe una importación de ventas para ${fecha}. Revierte ese día antes de reimportar.`);
        }

        const { consumo, sin_mapeo, ignorados, recetas_sin_escandallo } = calcularConsumo(
            lineas,
            posMapRes.rows,
            detalleRes.rows,
        );

        const preparaciones = armarPreparaciones(prepRes.rows, detalleRes.rows);
        const stockActual = new Map(stockRes.rows.map((s) => [Number(s.producto_id), Number(s.stock_actual)]));
        const { autoProduccion } = resolverPreparaciones(consumo, stockActual, preparaciones);

        const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
        const errores = [];
        // VENTA: el consumo original (insumos directos + elaborados explotados un nivel).
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

        const client = await pool.connect();
        const descontado = [];
        const negativos = [];
        try {
            await client.query("BEGIN");

            const ventaRes = await client.query(QUERIES.INSERT_VENTA, [
                empresa_id, fecha, total_lineas, total_unidades,
            ]);
            const venta = ventaRes.rows[0];

            // Snapshot del detalle de la venta (habilita el "ingreso esperado" en Finanzas).
            const posIndex = new Map(posMapRes.rows.map((m) => [normalizar(m.nombre_pos), m]));
            const precioReceta = new Map(recetasPrecioRes.rows.map((r) => [Number(r.id), r.precio_venta]));
            for (const l of lineas) {
                const m = posIndex.get(normalizar(l.nombre_pos));
                let tipo = "SIN_MAPEO";
                let dReceta = null;
                let dProducto = null;
                let dPrecio = null;
                if (m) {
                    tipo = m.tipo;
                    if (m.tipo === "RECETA") {
                        dReceta = Number(m.receta_id);
                        dPrecio = precioReceta.get(dReceta) ?? null;
                    } else if (m.tipo === "INSUMO") {
                        dProducto = Number(m.producto_id);
                    }
                }
                await client.query(QUERIES.INSERT_DETALLE, [venta.id, l.nombre_pos, Number(l.cantidad), tipo, dReceta, dProducto, dPrecio]);
            }

            // Pre-bloqueo de inventario en orden ascendente por producto_id: evita deadlocks
            // entre importaciones/producciones concurrentes, aunque los movimientos se apliquen
            // en fases (auto-producción y luego VENTA).
            const idsTocados = new Set();
            for (const it of aDescontar) idsTocados.add(Number(it.producto_id));
            for (const ap of autoProduccion) {
                idsTocados.add(Number(ap.producto_elaborado_id));
                for (const ins of ap.insumos) idsTocados.add(Number(ins.producto_id));
            }
            const idsOrden = [...idsTocados].sort((a, b) => a - b);
            if (idsOrden.length > 0) await client.query(QUERIES.LOCK_INV, [idsOrden]);

            const notaAuto = `Producción automática por venta del ${fecha}`;

            // 1) Insumos auto-producidos: PRODUCCION de salida (permite negativo).
            for (const ap of autoProduccion) {
                for (const ins of ap.insumos) {
                    if (!nombrePorId.has(Number(ins.producto_id))) {
                        errores.push({ producto_id: ins.producto_id, motivo: "Insumo de preparación inexistente en la empresa" });
                        ins.stock_resultante = null;
                        continue;
                    }
                    const mov = await this.movimientoRepository.aplicar(
                        client, ins.producto_id, empresa_id,
                        {
                            tipo_movimiento: "PRODUCCION",
                            cantidad: ins.cantidad,
                            motivo: notaAuto,
                            referencia_tipo: "VENTA_DIARIA",
                            referencia_id: venta.id,
                        },
                        { permitirNegativo: true },
                    );
                    if (!mov) {
                        errores.push({ producto_id: ins.producto_id, producto: nombrePorId.get(Number(ins.producto_id)), motivo: "El insumo no tiene fila de inventario" });
                        ins.stock_resultante = null;
                        continue;
                    }
                    ins.producto = nombrePorId.get(Number(ins.producto_id));
                    ins.stock_resultante = Number(mov.stock_nuevo);
                    if (Number(mov.stock_nuevo) < 0) {
                        negativos.push({ producto_id: ins.producto_id, producto: ins.producto, cantidad: ins.cantidad, stock_nuevo: Number(mov.stock_nuevo), origen: "PRODUCCION" });
                    }
                }
            }

            // 2) Elaborados auto-producidos: PRODUCCION de entrada (costo = costo vigente del elaborado).
            for (const ap of autoProduccion) {
                const mov = await this.movimientoRepository.aplicar(
                    client, ap.producto_elaborado_id, empresa_id,
                    {
                        tipo_movimiento: "PRODUCCION",
                        cantidad: ap.cantidad,
                        motivo: notaAuto,
                        referencia_tipo: "VENTA_DIARIA",
                        referencia_id: venta.id,
                    },
                    { direccion: 1, permitirNegativo: true },
                );
                ap.producto = nombrePorId.get(Number(ap.producto_elaborado_id)) ?? ap.nombre;
                ap.producto_id = Number(ap.producto_elaborado_id);
                ap.stock_elaborado_nuevo = mov ? Number(mov.stock_nuevo) : null;
            }

            // 3) VENTA del consumo (como siempre). El elaborado ya fue producido, así queda en 0 y no negativo.
            aDescontar.sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
            for (const item of aDescontar) {
                const mov = await this.movimientoRepository.aplicar(
                    client, item.producto_id, empresa_id,
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
                    errores.push({ producto_id: item.producto_id, producto: nombrePorId.get(item.producto_id), motivo: "El insumo no tiene fila de inventario" });
                    continue;
                }
                const registro = {
                    producto_id: item.producto_id,
                    producto: nombrePorId.get(item.producto_id),
                    cantidad: item.cantidad,
                    stock_nuevo: Number(mov.stock_nuevo),
                };
                descontado.push(registro);
                if (Number(mov.stock_nuevo) < 0) negativos.push({ ...registro, origen: "VENTA" });
            }

            await client.query("COMMIT");

            return {
                venta_diaria: venta,
                total_lineas,
                total_unidades,
                descontado,
                auto_produccion: autoProduccion.map((ap) => ({
                    producto_id: ap.producto_id,
                    producto: ap.producto,
                    receta_id: ap.receta_id,
                    cantidad: ap.cantidad,
                    unidad: ap.unidad,
                    lotes_equivalentes: ap.lotes_equivalentes,
                    insumos: ap.insumos,
                })),
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

    // Lista los días importados (encabezados) con su conteo de productos en negativo.
    async listarDias(empresa_id, { desde = null, hasta = null } = {}) {
        const res = await pool.query(QUERIES.LIST_DIAS, [empresa_id, desde, hasta]);
        return res.rows;
    }

    // Previsualiza el efecto de un mix de ventas SIN escribir nada (mapeo + consumo + auto-producción).
    async previsualizar(empresa_id, lineas) {
        const [posMapRes, detalleRes, prodRes, prepRes, stockRes] = await Promise.all([
            pool.query(QUERIES.POS_MAP, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_EMPRESA, [empresa_id]),
            pool.query(QUERIES.RECETAS_PREP, [empresa_id]),
            pool.query(QUERIES.STOCK_EMPRESA, [empresa_id]),
        ]);
        const { consumo, sin_mapeo, ignorados, recetas_sin_escandallo } = calcularConsumo(
            lineas,
            posMapRes.rows,
            detalleRes.rows,
        );
        const preparaciones = armarPreparaciones(prepRes.rows, detalleRes.rows);
        const stockActual = new Map(stockRes.rows.map((s) => [Number(s.producto_id), Number(s.stock_actual)]));
        const { consumoFinal, autoProduccion } = resolverPreparaciones(consumo, stockActual, preparaciones);

        const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
        const producidoPorId = new Map(autoProduccion.map((ap) => [Number(ap.producto_elaborado_id), ap.cantidad]));

        // Existencia resultante por producto = stock + auto-producido - consumo total (VENTA + PRODUCCION).
        const existencia = (pid) =>
            r3(Number(stockActual.get(pid) ?? 0) + Number(producidoPorId.get(pid) ?? 0) - Number(consumoFinal.get(pid) ?? 0));

        const consumoList = [];
        const errores = [];
        for (const [producto_id, cantidad] of consumoFinal.entries()) {
            if (!nombrePorId.has(producto_id)) {
                errores.push({ producto_id, motivo: "El mapeo apunta a un insumo inexistente en la empresa" });
                continue;
            }
            const existencia_resultante = existencia(producto_id);
            consumoList.push({
                producto_id,
                producto: nombrePorId.get(producto_id),
                cantidad,
                existencia_resultante,
                negativo: existencia_resultante < 0,
            });
        }

        // stock_resultante de cada insumo auto-producido: simula la fase 1 del import
        // (PRODUCCION de salida en orden) para que coincida exactamente con el import.
        const running = new Map(stockActual);
        const autoPreview = autoProduccion.map((ap) => ({
            producto_id: Number(ap.producto_elaborado_id),
            producto: nombrePorId.get(Number(ap.producto_elaborado_id)) ?? ap.nombre,
            receta_id: ap.receta_id,
            cantidad: ap.cantidad,
            unidad: ap.unidad,
            lotes_equivalentes: ap.lotes_equivalentes,
            insumos: ap.insumos.map((ins) => {
                const pid = Number(ins.producto_id);
                const nuevo = r3(Number(running.get(pid) ?? 0) - Number(ins.cantidad));
                running.set(pid, nuevo);
                return {
                    producto_id: pid,
                    producto: nombrePorId.get(pid) ?? null,
                    cantidad: ins.cantidad,
                    stock_resultante: nuevo,
                };
            }),
        }));

        return {
            total_lineas: lineas.length,
            total_unidades: lineas.reduce((sum, l) => sum + Number(l.cantidad), 0),
            consumo: consumoList,
            auto_produccion: autoPreview,
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
        const movs = (await pool.query(QUERIES.MOV_POR_REFERENCIA, [venta.id])).rows;

        // Reconstruye la auto-producción desde los movimientos PRODUCCION de esta venta.
        const entradas = movs.filter((m) => m.tipo_movimiento === "PRODUCCION" && Number(m.stock_nuevo) > Number(m.stock_anterior));
        const salidas = movs.filter((m) => m.tipo_movimiento === "PRODUCCION" && Number(m.stock_nuevo) < Number(m.stock_anterior));
        let auto_produccion = [];
        if (entradas.length > 0) {
            const [prepRows, detRows] = await Promise.all([
                pool.query(QUERIES.PREP_INDEX, [empresa_id]),
                pool.query(QUERIES.PREP_DETALLE, [empresa_id]),
            ]);
            const prepByElab = new Map(prepRows.rows.map((r) => [Number(r.producto_elaborado_id), r]));
            const insumosByReceta = new Map();
            for (const d of detRows.rows) {
                const k = Number(d.receta_id);
                if (!insumosByReceta.has(k)) insumosByReceta.set(k, new Set());
                insumosByReceta.get(k).add(Number(d.producto_id));
            }
            auto_produccion = entradas.map((e) => {
                const prep = prepByElab.get(Number(e.producto_id));
                const rendimiento = prep ? Number(prep.rendimiento) || 1 : 1;
                const idsInsumo = prep ? insumosByReceta.get(Number(prep.receta_id)) ?? new Set() : new Set();
                const insumos = salidas
                    .filter((s) => idsInsumo.has(Number(s.producto_id)))
                    .map((s) => ({
                        producto_id: Number(s.producto_id),
                        producto: s.producto,
                        cantidad: Number(s.cantidad),
                        stock_resultante: Number(s.stock_nuevo),
                    }));
                return {
                    producto_id: Number(e.producto_id),
                    producto: e.producto,
                    receta_id: prep ? Number(prep.receta_id) : null,
                    cantidad: Number(e.cantidad),
                    unidad: prep ? prep.unidad : null,
                    lotes_equivalentes: r3(Number(e.cantidad) / rendimiento),
                    insumos,
                };
            });
        }

        return { ...venta, movimientos: movs, auto_produccion };
    }

    // Revierte un día: deshace TODOS los movimientos de la venta para que cada existencia
    // vuelva exactamente a como estaba. VENTA -> DEVOLUCION (mismo costo, para que costo_ventas
    // quede en 0). PRODUCCION -> su inverso (no toca costo_ventas ni merma). Borra el encabezado.
    async revertirDia(empresa_id, fecha) {
        const ventaRes = await pool.query(QUERIES.SELECT_VENTA, [empresa_id, fecha]);
        const venta = ventaRes.rows[0];
        if (!venta) return null;

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const movs = (await client.query(QUERIES.MOV_POR_REFERENCIA, [venta.id])).rows;

            // Pre-bloqueo en orden ascendente por producto_id (deadlock-safe).
            const ids = [...new Set(movs.map((m) => Number(m.producto_id)))].sort((a, b) => a - b);
            if (ids.length > 0) await client.query(QUERIES.LOCK_INV, [ids]);

            const enOrden = [...movs].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
            let revertidos = 0;
            for (const m of enOrden) {
                const subio = Number(m.stock_nuevo) > Number(m.stock_anterior);
                let data;
                if (m.tipo_movimiento === "VENTA") {
                    data = {
                        tipo_movimiento: "DEVOLUCION",
                        cantidad: m.cantidad,
                        costo_unitario: m.costo_unitario,
                        motivo: `Reversa venta diaria ${fecha}`,
                        referencia_tipo: "VENTA_DIARIA",
                        referencia_id: venta.id,
                    };
                } else if (m.tipo_movimiento === "PRODUCCION") {
                    // Inverso de la producción: NO usar DEVOLUCION (ensuciaría costo_ventas).
                    data = {
                        tipo_movimiento: "PRODUCCION",
                        cantidad: m.cantidad,
                        costo_unitario: m.costo_unitario,
                        motivo: `Reversa venta diaria ${fecha}`,
                        referencia_tipo: "VENTA_DIARIA",
                        referencia_id: venta.id,
                    };
                } else {
                    continue;
                }
                const opts = { permitirNegativo: true };
                if (m.tipo_movimiento === "PRODUCCION") opts.direccion = subio ? -1 : 1;
                await this.movimientoRepository.aplicar(client, m.producto_id, empresa_id, data, opts);
                revertidos++;
            }
            await client.query(QUERIES.DELETE_VENTA, [venta.id, empresa_id]);
            await client.query("COMMIT");
            return { revertidos, fecha };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
