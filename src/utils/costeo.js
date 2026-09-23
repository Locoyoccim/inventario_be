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

// Contexto de una cascada de costos: productos ya propagados y recetas tocadas.
const nuevoCtx = () => ({ productos: new Set(), recetas: new Set() });

// Recalcula y PERSISTE costo_total de una receta dentro de una transacción (client).
// Lee producción y protección del encabezado y la suma del escandallo.
// Si la receta es una preparación, el nuevo costo se propaga en cascada a las
// recetas que la usan como insumo. `ctx.productos` (ids ya propagados) evita ciclos.
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

    // Si la receta es una preparación, propaga el costo al producto elaborado enlazado.
    // productos.costo_unitario es GENERATED = costo_presentacion / cantidad_presentacion,
    // así que con costo_presentacion = costo_total y cantidad_presentacion = rendimiento
    // el costo por unidad de la preparación queda siempre fresco.
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

// Cuando cambia el costo de uno o más insumos (compra, edición de producto o una
// preparación recalculada), refresca el snapshot receta_detalle.costo_unitario de
// las recetas que los usan y recalcula su costo_total (y, si son preparaciones,
// sigue la cascada). Debe llamarse dentro de la misma transacción (client).
// Devuelve los ids de TODAS las recetas recalculadas (incluida la cascada).

export async function propagarCostoInsumos(client, productoIds, ctx = nuevoCtx()) {
    const ids = [...new Set(productoIds.map(Number))].filter((id) => id > 0 && !ctx.productos.has(id));
    ids.forEach((id) => ctx.productos.add(id));
    if (ids.length === 0) return [...ctx.recetas];

    const res = await client.query(
        `UPDATE receta_detalle rd
         SET costo_unitario = p.costo_unitario
         FROM productos p
         WHERE p.id = rd.producto_id
           AND rd.producto_id = ANY($1)
           AND rd.costo_unitario IS DISTINCT FROM p.costo_unitario
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

// Preview SIN persistir: calcula sobre los costos vigentes de los insumos.
export async function calcularPreview(empresa_id, data) {
    const {
        precio_venta = 0,
        costo_produccion = 0,
        proteccion_pct = 0,
        ingredientes = [],
    } = data;

    const ids = ingredientes.map((i) => Number(i.producto_id));
    const prodRes = await pool.query(
        "SELECT id, producto, costo_unitario FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
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
        const costo_final = Number(cantidad) * Number(p.costo_unitario);
        sumaInsumos += costo_final;
        detalle.push({
            producto_id, producto: p.producto, cantidad,
            costo_unitario: Number(p.costo_unitario),
            costo_final: Number(costo_final.toFixed(4)),
        });
    }

    const costo_total = costoTotal({ sumaInsumos, costoProduccion: costo_produccion, proteccionPct: proteccion_pct });
    return {
        suma_insumos: Number(sumaInsumos.toFixed(4)),
        costo_produccion: Number(costo_produccion),
        proteccion_pct: Number(proteccion_pct),
        costo_total: Number(costo_total.toFixed(2)),
        precio_venta: Number(precio_venta),
        margen: Number(margen(precio_venta, costo_total).toFixed(2)),
        ingredientes: detalle,
    };
}
