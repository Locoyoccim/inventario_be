import pool from "../../config/db.js";
import { normalizar } from "../../utils/normalize.js";
import ApiError from "../../utils/ApiError.js";
import { explotarRenglones } from "../../utils/consumo.js";
import { resolverPreparaciones, armarPreparaciones } from "../../utils/preparaciones.js";
import { aplicarConsumo, revertirPorReferencia } from "../movimientos/aplicarConsumo.js";
import { QUERIES } from "./venta.queries.js";

export { resolverPreparaciones };

const r3 = (n) => Number(Number(n).toFixed(3));

// --- Lógica pura (testeable sin BD) --------------------------------------
// Resuelve las líneas del POS contra el mapeo y explota recetas UN nivel,
// agregando el consumo total por insumo/elaborado (producto_id).
export function calcularConsumo(lineas, posMap, recetaDetalle, mermaPorId = new Map()) {
    const mapa = new Map(); // nombre_pos normalizado -> fila de pos_map
    for (const m of posMap) mapa.set(normalizar(m.nombre_pos), m);

    const renglones = [];
    const sin_mapeo = [];
    const ignorados = [];

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
            renglones.push({ producto_id: Number(m.producto_id), cantidad: cant * factor });
        } else if (m.tipo === "RECETA") {
            renglones.push({ receta_id: Number(m.receta_id), cantidad: cant * factor, nombre_pos: linea.nombre_pos, cantidad_pos: cant });
        }
    }

    const { consumo, recetas_sin_escandallo } = explotarRenglones(renglones, recetaDetalle, mermaPorId);
    return {
        consumo,
        sin_mapeo,
        ignorados,
        recetas_sin_escandallo: recetas_sin_escandallo.map((r) => ({ nombre_pos: r.nombre_pos, receta_id: r.receta_id, cantidad: r.cantidad_pos })),
    };
}

// --- Repositorio ----------------------------------------------------------
export default class VentaRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    // Carga y resuelve el contexto de venta compartido por importarDia y previsualizar:
    // mapeo POS + escandallo + productos + preparaciones + stock, consumo explotado
    // (calcularConsumo) y su propagación a insumos vía auto-producción (resolverPreparaciones).
    async #cargarContextoVenta(empresa_id, lineas) {
        const [posMapRes, detalleRes, prodRes, prepRes, stockRes] = await Promise.all([
            pool.query(QUERIES.POS_MAP, [empresa_id]),
            pool.query(QUERIES.RECETA_DETALLE, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_EMPRESA, [empresa_id]),
            pool.query(QUERIES.RECETAS_PREP, [empresa_id]),
            pool.query(QUERIES.STOCK_EMPRESA, [empresa_id]),
        ]);

        const mermaPorId = new Map(prodRes.rows.map((p) => [Number(p.id), Number(p.merma_pct) || 0]));
        const { consumo, sin_mapeo, ignorados, recetas_sin_escandallo } = calcularConsumo(
            lineas,
            posMapRes.rows,
            detalleRes.rows,
            mermaPorId,
        );

        const preparaciones = armarPreparaciones(prepRes.rows, detalleRes.rows);
        const stockActual = new Map(stockRes.rows.map((s) => [Number(s.producto_id), Number(s.stock_actual)]));
        const { consumoFinal, autoProduccion } = resolverPreparaciones(consumo, stockActual, preparaciones, mermaPorId);

        return {
            posMapRes,
            detalleRes,
            prodRes,
            prepRes,
            stockRes,
            mermaPorId,
            consumo,
            sin_mapeo,
            ignorados,
            recetas_sin_escandallo,
            preparaciones,
            stockActual,
            consumoFinal,
            autoProduccion,
        };
    }

    // Inserta el encabezado (venta_diaria) y el snapshot de detalle línea por línea
    // (habilita el "ingreso esperado" en Finanzas). Devuelve la fila de venta insertada.
    async #insertarEncabezadoYDetalle(client, empresa_id, fecha, lineas, posMapRes, recetasPrecioRes, productosPrecioRes, total_lineas, total_unidades) {
        const ventaRes = await client.query(QUERIES.INSERT_VENTA, [
            empresa_id, fecha, total_lineas, total_unidades,
        ]);
        const venta = ventaRes.rows[0];

        // Snapshot del detalle de la venta (habilita el "ingreso esperado" en Finanzas).
        const posIndex = new Map(posMapRes.rows.map((m) => [normalizar(m.nombre_pos), m]));
        const precioReceta = new Map(recetasPrecioRes.rows.map((r) => [Number(r.id), r.precio_venta]));
        const precioProducto = new Map(productosPrecioRes.rows.map((p) => [Number(p.id), p.precio_venta]));
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
                    // null si el producto no tiene precio_venta capturado: el esperado de ese
                    // renglón queda sin contar (igual que antes), pero ahora SÍ hay forma de
                    // cerrar el hueco capturando el precio en el producto.
                    dPrecio = precioProducto.get(dProducto) ?? null;
                }
            }
            await client.query(QUERIES.INSERT_DETALLE, [venta.id, l.nombre_pos, Number(l.cantidad), tipo, dReceta, dProducto, dPrecio]);
        }

        return venta;
    }

    async importarDia(empresa_id, fecha, lineas) {
        const [existeRes, recetasPrecioRes, productosPrecioRes] = await Promise.all([
            pool.query(QUERIES.VENTA_EXISTE, [empresa_id, fecha]),
            pool.query(QUERIES.RECETAS_PRECIO, [empresa_id]),
            pool.query(QUERIES.PRODUCTOS_PRECIO, [empresa_id]),
        ]);

        if (existeRes.rows[0]) {
            throw ApiError.conflict(`Ya existe una importación de ventas para ${fecha}. Revierte ese día antes de reimportar.`);
        }

        const {
            posMapRes,
            prodRes,
            consumo,
            sin_mapeo,
            ignorados,
            recetas_sin_escandallo,
            autoProduccion,
        } = await this.#cargarContextoVenta(empresa_id, lineas);

        const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
        const total_lineas = lineas.length;
        const total_unidades = lineas.reduce((s, l) => s + Number(l.cantidad), 0);

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const venta = await this.#insertarEncabezadoYDetalle(
                client, empresa_id, fecha, lineas, posMapRes, recetasPrecioRes, productosPrecioRes, total_lineas, total_unidades,
            );

            const { descontado, negativos, errores } = await aplicarConsumo(client, this.movimientoRepository, empresa_id, {
                consumo,
                autoProduccion,
                nombrePorId,
                referencia_tipo: "VENTA_DIARIA",
                referencia_id: venta.id,
                motivoAuto: `Producción automática por venta del ${fecha}`,
                motivoVenta: `Venta diaria ${fecha}`,
            });

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
        const { prodRes, sin_mapeo, ignorados, recetas_sin_escandallo, stockActual, consumoFinal, autoProduccion } =
            await this.#cargarContextoVenta(empresa_id, lineas);

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

    // Reconstruye la auto-producción desde los movimientos PRODUCCION de esta venta.
    async #reconstruirAutoProduccion(empresa_id, movs) {
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
        return auto_produccion;
    }

    async consultarDia(empresa_id, fecha) {
        const ventaRes = await pool.query(QUERIES.SELECT_VENTA, [empresa_id, fecha]);
        const venta = ventaRes.rows[0];
        if (!venta) return null;
        const movs = (await pool.query(QUERIES.MOV_POR_REFERENCIA, [venta.id, empresa_id])).rows;

        const auto_produccion = await this.#reconstruirAutoProduccion(empresa_id, movs);

        return { ...venta, movimientos: movs, auto_produccion };
    }

    // Revierte un día: deshace TODOS los movimientos de la venta para que cada existencia
    // vuelva exactamente a como estaba. VENTA -> DEVOLUCION (mismo costo, para que costo_ventas
    // quede en 0). PRODUCCION -> su inverso (no toca costo_ventas ni merma). Borra el encabezado.
    async revertirDia(empresa_id, fecha) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // FOR UPDATE bloquea la fila hasta que esta transacción termine: una segunda
            // reversa concurrente para el mismo empresa_id/fecha se queda esperando aquí,
            // y al despertar (fila ya borrada por la primera) simplemente no encuentra nada.
            const ventaRes = await client.query(QUERIES.SELECT_VENTA_FOR_UPDATE, [empresa_id, fecha]);
            const venta = ventaRes.rows[0];
            if (!venta) {
                await client.query("ROLLBACK");
                return null;
            }

            const revertidos = await revertirPorReferencia(client, this.movimientoRepository, empresa_id, {
                referencia_tipo: "VENTA_DIARIA",
                referencia_id: venta.id,
                motivo: `Reversa venta diaria ${fecha}`,
            });
            const delRes = await client.query(QUERIES.DELETE_VENTA, [venta.id, empresa_id]);
            if (delRes.rowCount === 0) {
                await client.query("ROLLBACK");
                return null;
            }
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
