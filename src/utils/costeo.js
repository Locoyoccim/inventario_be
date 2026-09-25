import ApiError from "./ApiError.js";
import pool from "../config/db.js";

// ÚNICA definición de la fórmula de costeo del sistema.
// costo_total = (insumos + producción) * (1 + protección%/100)
export function costoTotal({ sumaInsumos = 0, costoProduccion = 0, proteccionPct = 0 }) {
    const base = Number(sumaInsumos) + Number(costoProduccion);
    return base * (1 + Number(proteccionPct) / 100);
}

export function margen(precioVenta, costo) {
    const pv = Number(precioVenta);
    return pv > 0 ? ((pv - Number(costo)) / pv) * 100 : 0;
}

// --- Merma de limpieza (cáscara/hueso/recorte) ---------------------------------
// Factor para pasar de neto (lo que va al plato) a bruto (lo que se descuenta del
// inventario) y para el costo útil. merma válida en [0, 90).
export function factorMerma(mermaPct) {
    const m = Number(mermaPct) || 0;
    return m > 0 && m < 100 ? 1 / (1 - m / 100) : 1;
}
// Cantidad bruta a descontar del inventario a partir de la neta (3 decimales).
export function netoABruto(neto, mermaPct) {
    return Number((Number(neto) * factorMerma(mermaPct)).toFixed(3));
}
// Costo útil = costo bruto de compra / (1 − merma) (4 decimales).
export function costoUtil(costoUnitario, mermaPct) {
    return Number((Number(costoUnitario) * factorMerma(mermaPct)).toFixed(4));
}
// Redondeo comercial al múltiplo de $5 más cercano.
export function round5(n) {
    return Math.round(Number(n) / 5) * 5;
}

// Deriva los campos de precio de una receta (IVA, neto, costo %, utilidad, precio sugerido).
// precioNeto/costoPct pueden venir ya calculados por la BD (columnas GENERATED); si no, se calculan.
export function enriquecerReceta(receta, foodCostObjetivo = 30) {
    if (!receta) return receta;
    const precioVenta = Number(receta.precio_venta) || 0;
    const iva = Number(receta.iva_pct) || 0;
    const incluye = receta.precio_incluye_iva !== false;
    const costo = Number(receta.costo_total) || 0;
    const precioNeto = receta.precio_neto != null
        ? Number(receta.precio_neto)
        : Number(((incluye ? precioVenta / (1 + iva / 100) : precioVenta)).toFixed(2));
    const ivaMonto = Number((precioVenta - precioNeto).toFixed(2));
    const utilidad = Number((precioNeto - costo).toFixed(2));
    const costoPct = receta.costo_pct != null
        ? Number(receta.costo_pct)
        : (precioNeto > 0 ? Number(((costo / precioNeto) * 100).toFixed(2)) : null);
    const obj = Number(foodCostObjetivo) || 30;
    let sugerido = 0;
    if (obj > 0 && costo > 0) {
        sugerido = costo / (obj / 100);
        if (incluye) sugerido *= 1 + iva / 100;
        sugerido = round5(sugerido);
    }
    return {
        ...receta,
        precio_neto: precioNeto,
        iva_monto: ivaMonto,
        costo_pct: costoPct,
        utilidad,
        precio_sugerido: sugerido,
    };
}

// Contexto de una cascada de costos: productos ya propagados y recetas tocadas.
const nuevoCtx = () => ({ productos: new Set(), recetas: new Set() });

// Recalcula y PERSISTE costo_total de una receta dentro de una transacción (client).
export async function recalcularCostoTotal(client, recetaId, ctx = nuevoCtx()) {
    const cab = await client.query(
        "SELECT precio_venta, costo_produccion, proteccion_pct, rendimiento, producto_elaborado_id FROM recetas WHERE id = $1",
        [recetaId]
    );
    if (!cab.rows[0]) return null;

    const suma = await client.query(
        "SELECT COALESCE(SUM(costo_final), 0) AS suma FROM receta_detalle WHERE receta_id = $1",
        [recetaId]
    );

    const total = costoTotal({
        sumaInsumos: suma.rows[0].suma,
        costoProduccion: cab.rows[0].costo_produccion,
        proteccionPct: cab.rows[0].proteccion_pct,
    });

    const upd = await client.query(
        "UPDATE recetas SET costo_total = $1 WHERE id = $2 RETURNING *",
        [total, recetaId]
    );

    const prodElabId = cab.rows[0].producto_elaborado_id;
    if (prodElabId) {
        const rendimiento = Number(cab.rows[0].rendimiento) || 1;
        await client.query(
            "UPDATE productos SET costo_presentacion = $1, cantidad_presentacion = $2 WHERE id = $3",
            [Number(total), rendimiento, prodElabId]
        );
        await propagarCostoInsumos(client, [prodElabId], ctx);
    }

    return upd.rows[0];
}

// Cuando cambia el costo o la MERMA de uno o más insumos (compra, edición de producto o una
// preparación recalculada), refresca el snapshot receta_detalle.costo_unitario = COSTO ÚTIL
// (costo bruto / (1 − merma)) de las recetas que los usan y recalcula su costo_total (y, si
// son preparaciones, sigue la cascada). Debe llamarse dentro de la misma transacción (client).
export async function propagarCostoInsumos(client, productoIds, ctx = nuevoCtx()) {
    const ids = [...new Set(productoIds.map(Number))].filter((id) => id > 0 && !ctx.productos.has(id));
    ids.forEach((id) => ctx.productos.add(id));
    if (ids.length === 0) return [...ctx.recetas];

    const res = await client.query(
        `UPDATE receta_detalle rd
         SET costo_unitario = ROUND(p.costo_unitario / (1 - COALESCE(p.merma_pct, 0) / 100), 4)
         FROM productos p
         WHERE p.id = rd.producto_id
           AND rd.producto_id = ANY($1)
           AND rd.costo_unitario IS DISTINCT FROM ROUND(p.costo_unitario / (1 - COALESCE(p.merma_pct, 0) / 100), 4)
         RETURNING rd.receta_id`,
        [ids]
    );
    const recetas = [...new Set(res.rows.map((r) => Number(r.receta_id)))];
    for (const recetaId of recetas) {
        ctx.recetas.add(recetaId);
        await recalcularCostoTotal(client, recetaId, ctx);
    }
    return [...ctx.recetas];
}

// Preview SIN persistir: calcula sobre el COSTO ÚTIL vigente de los insumos y devuelve
// los campos derivados de precio (IVA/neto/costo%/utilidad/sugerido).
export async function calcularPreview(empresa_id, data) {
    const {
        precio_venta = 0,
        costo_produccion = 0,
        proteccion_pct = 0,
        ingredientes = [],
        iva_pct = null,
        precio_incluye_iva = null,
    } = data;

    const cfg = (await pool.query(
        "SELECT iva_pct, precios_incluyen_iva, food_cost_objetivo FROM empresas WHERE id = $1",
        [empresa_id]
    )).rows[0] || { iva_pct: 16, precios_incluyen_iva: true, food_cost_objetivo: 30 };

    const ids = ingredientes.map((i) => Number(i.producto_id));
    const prodRes = await pool.query(
        "SELECT id, producto, costo_unitario, merma_pct FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
        [empresa_id, ids]
    );
    const prodMap = new Map(prodRes.rows.map((r) => [Number(r.id), r]));

    let sumaInsumos = 0;
    const detalle = [];
    for (const ing of ingredientes) {
        const { producto_id, cantidad } = ing;
        if (!producto_id || cantidad === undefined || cantidad === null) {
            throw ApiError.badRequest("Cada ingrediente requiere 'producto_id' y 'cantidad'");
        }
        const p = prodMap.get(Number(producto_id));
        if (!p) throw ApiError.badRequest(`El producto ${producto_id} no existe en la empresa ${empresa_id}`);
        const util = costoUtil(p.costo_unitario, p.merma_pct);
        const costo_final = Number(cantidad) * util;
        sumaInsumos += costo_final;
        detalle.push({
            producto_id, producto: p.producto, cantidad,
            costo_unitario: util,
            costo_final: Number(costo_final.toFixed(4)),
        });
    }

    const costo_total = costoTotal({ sumaInsumos, costoProduccion: costo_produccion, proteccionPct: proteccion_pct });
    const iva = iva_pct != null ? Number(iva_pct) : Number(cfg.iva_pct);
    const incluye = precio_incluye_iva != null ? precio_incluye_iva !== false : cfg.precios_incluyen_iva !== false;
    const base = {
        suma_insumos: Number(sumaInsumos.toFixed(4)),
        costo_produccion: Number(costo_produccion),
        proteccion_pct: Number(proteccion_pct),
        costo_total: Number(costo_total.toFixed(2)),
        precio_venta: Number(precio_venta),
        iva_pct: iva,
        precio_incluye_iva: incluye,
        margen: Number(margen(incluye ? Number(precio_venta) / (1 + iva / 100) : Number(precio_venta), costo_total).toFixed(2)),
        ingredientes: detalle,
    };
    return enriquecerReceta(base, cfg.food_cost_objetivo);
}
