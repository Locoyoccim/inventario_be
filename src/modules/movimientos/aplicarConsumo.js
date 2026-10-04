// Escritura de un consumo de venta en inventario, compartida por la importación diaria
// (referencia VENTA_DIARIA) y el POS (referencia POS_CUENTA). Todas las funciones reciben un
// client con la transacción YA abierta; no hacen BEGIN/COMMIT.
import { explotarRenglones } from "../../utils/consumo.js";
import { armarPreparaciones, resolverPreparaciones } from "../../utils/preparaciones.js";

const LOCK_INV = `SELECT producto_id FROM inventario WHERE producto_id = ANY($1::int[]) ORDER BY producto_id FOR UPDATE`;

const MOV_POR_REFERENCIA = `
    SELECT m.producto_id, p.producto, m.tipo_movimiento, m.cantidad, m.costo_unitario,
           m.stock_anterior, m.stock_nuevo
    FROM movimientosinventario m
    JOIN productos p ON p.id = m.producto_id
    WHERE m.referencia_tipo = $1 AND m.referencia_id = $2 AND p.empresa_id = $3
    ORDER BY m.id ASC`;

// Pre-bloqueo en orden ascendente por producto_id: evita deadlocks con otras ventas,
// producciones o reversas concurrentes aunque los movimientos se apliquen en fases.
async function bloquearInventario(client, aDescontar, autoProduccion) {
    const ids = new Set();
    for (const it of aDescontar) ids.add(Number(it.producto_id));
    for (const ap of autoProduccion) {
        ids.add(Number(ap.producto_elaborado_id));
        for (const ins of ap.insumos) ids.add(Number(ins.producto_id));
    }
    const orden = [...ids].sort((a, b) => a - b);
    if (orden.length > 0) await client.query(LOCK_INV, [orden]);
}

// Aplica el consumo en 3 fases: (1) salida de insumos auto-producidos, (2) entrada de los
// elaborados auto-producidos, (3) salida del consumo (VENTA, o MERMA si se preparó y no se vendió). Siempre permite negativo: la venta ya
// ocurrió y un stock negativo es señal de inventario desfasado, no un error a bloquear.
// Muta autoProduccion (producto, producto_id, stock_resultante...) para el reporte de quien llama.
export async function aplicarConsumo(client, movimientoRepository, empresa_id, opts) {
    // tipoSalida: «VENTA» (lo vendido) o «MERMA» (lo preparado y no vendido, p. ej. un platillo cancelado ya enviado a cocina).
    const { consumo, autoProduccion, nombrePorId, referencia_tipo, referencia_id, usuario_id = null, motivoAuto, motivoVenta, tipoSalida = "VENTA" } = opts;
    const errores = [];
    const negativos = [];
    const descontado = [];

    const aDescontar = [];
    for (const [producto_id, cantidad] of consumo.entries()) {
        if (!nombrePorId.has(producto_id)) {
            errores.push({ producto_id, motivo: "El mapeo apunta a un insumo inexistente en la empresa" });
        } else {
            aDescontar.push({ producto_id, cantidad });
        }
    }

    await bloquearInventario(client, aDescontar, autoProduccion);
    const ref = { referencia_tipo, referencia_id, usuario_id };

    for (const ap of autoProduccion) {
        for (const ins of ap.insumos) {
            if (!nombrePorId.has(Number(ins.producto_id))) {
                errores.push({ producto_id: ins.producto_id, motivo: "Insumo de preparación inexistente en la empresa" });
                ins.stock_resultante = null;
                continue;
            }
            const mov = await movimientoRepository.aplicar(
                client, ins.producto_id, empresa_id,
                { tipo_movimiento: "PRODUCCION", cantidad: ins.cantidad, motivo: motivoAuto, ...ref },
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

    for (const ap of autoProduccion) {
        const mov = await movimientoRepository.aplicar(
            client, ap.producto_elaborado_id, empresa_id,
            { tipo_movimiento: "PRODUCCION", cantidad: ap.cantidad, motivo: motivoAuto, ...ref },
            { direccion: 1, permitirNegativo: true },
        );
        ap.producto = nombrePorId.get(Number(ap.producto_elaborado_id)) ?? ap.nombre;
        ap.producto_id = Number(ap.producto_elaborado_id);
        ap.stock_elaborado_nuevo = mov ? Number(mov.stock_nuevo) : null;
    }

    aDescontar.sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
    for (const item of aDescontar) {
        const mov = await movimientoRepository.aplicar(
            client, item.producto_id, empresa_id,
            { tipo_movimiento: tipoSalida, cantidad: item.cantidad, motivo: motivoVenta, ...ref },
            { permitirNegativo: true },
        );
        if (!mov) {
            errores.push({ producto_id: item.producto_id, producto: nombrePorId.get(item.producto_id), motivo: "El insumo no tiene fila de inventario" });
            continue;
        }
        const registro = { producto_id: item.producto_id, producto: nombrePorId.get(item.producto_id), cantidad: item.cantidad, stock_nuevo: Number(mov.stock_nuevo) };
        descontado.push(registro);
        if (Number(mov.stock_nuevo) < 0) negativos.push({ ...registro, origen: tipoSalida });
    }

    return { descontado, negativos, errores };
}

// Deshace todos los movimientos de una referencia para que cada existencia vuelva a como estaba.
// VENTA -> DEVOLUCION al mismo costo (costo de ventas queda en 0); PRODUCCION -> su inverso
// (no ensucia costo de ventas). Devuelve cuántos movimientos se revirtieron.
export async function revertirPorReferencia(client, movimientoRepository, empresa_id, { referencia_tipo, referencia_id, motivo, usuario_id = null }) {
    const movs = (await client.query(MOV_POR_REFERENCIA, [referencia_tipo, referencia_id, empresa_id])).rows;

    const ids = [...new Set(movs.map((m) => Number(m.producto_id)))].sort((a, b) => a - b);
    if (ids.length > 0) await client.query(LOCK_INV, [ids]);

    const enOrden = [...movs].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
    let revertidos = 0;
    for (const m of enOrden) {
        if (m.tipo_movimiento !== "VENTA" && m.tipo_movimiento !== "PRODUCCION") continue;
        const data = {
            tipo_movimiento: m.tipo_movimiento === "VENTA" ? "DEVOLUCION" : "PRODUCCION",
            cantidad: m.cantidad,
            costo_unitario: m.costo_unitario,
            motivo,
            referencia_tipo,
            referencia_id,
            usuario_id,
        };
        const opts = { permitirNegativo: true };
        if (m.tipo_movimiento === "PRODUCCION") opts.direccion = Number(m.stock_nuevo) > Number(m.stock_anterior) ? -1 : 1;
        await movimientoRepository.aplicar(client, m.producto_id, empresa_id, data, opts);
        revertidos++;
    }
    return revertidos;
}

// Contexto de consumo acotado a lo vendido (para un ticket, no un día completo): escandallo de
// las recetas vendidas + todas las preparaciones (pueden anidarse) y stock solo de elaborados.
// renglones: [{ receta_id | producto_id, cantidad }]
export async function cargarContextoConsumo(db, empresa_id, renglones) {
    const recetaIds = [...new Set(renglones.filter((r) => r.receta_id != null).map((r) => Number(r.receta_id)))];
    const [detalleRes, prodRes, prepRes] = await Promise.all([
        db.query(
            `SELECT rd.receta_id, rd.producto_id, rd.cantidad
             FROM receta_detalle rd JOIN recetas r ON r.id = rd.receta_id
             WHERE r.empresa_id = $1 AND (rd.receta_id = ANY($2::int[]) OR r.es_preparacion = true)`,
            [empresa_id, recetaIds],
        ),
        db.query("SELECT id, producto, merma_pct FROM productos WHERE empresa_id = $1", [empresa_id]),
        db.query(
            `SELECT r.id AS receta_id, r.rendimiento, r.producto_elaborado_id, r.nombre, p.unidad_medida AS unidad
             FROM recetas r JOIN productos p ON p.id = r.producto_elaborado_id
             WHERE r.empresa_id = $1 AND r.es_preparacion = true AND r.producto_elaborado_id IS NOT NULL`,
            [empresa_id],
        ),
    ]);

    const mermaPorId = new Map(prodRes.rows.map((p) => [Number(p.id), Number(p.merma_pct) || 0]));
    const nombrePorId = new Map(prodRes.rows.map((p) => [Number(p.id), p.producto]));
    const { consumo, recetas_sin_escandallo } = explotarRenglones(renglones, detalleRes.rows, mermaPorId);

    const preparaciones = armarPreparaciones(prepRes.rows, detalleRes.rows);
    const elaborados = [...preparaciones.keys()];
    const stockRes = elaborados.length
        ? await db.query("SELECT producto_id, stock_actual FROM inventario WHERE empresa_id = $1 AND producto_id = ANY($2::int[])", [empresa_id, elaborados])
        : { rows: [] };
    const stockActual = new Map(stockRes.rows.map((s) => [Number(s.producto_id), Number(s.stock_actual)]));
    const { autoProduccion } = resolverPreparaciones(consumo, stockActual, preparaciones, mermaPorId);

    return { consumo, autoProduccion, nombrePorId, recetas_sin_escandallo };
}
