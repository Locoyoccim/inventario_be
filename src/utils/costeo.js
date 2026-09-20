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

// Recalcula y PERSISTE costo_total de una receta dentro de una transacción (client).
// Lee producción y protección del encabezado y la suma del escandallo.
export async function recalcularCostoTotal(client, recetaId) {
    const cab = await client.query(
        "SELECT precio_venta, costo_produccion, proteccion_pct FROM recetas WHERE id = $1",
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
    return upd.rows[0];
}

// Preview SIN persistir: calcula sobre los costos vigentes de los insumos.
export async function calcularPreview(empresa_id, data) {
    const {
        precio_venta = 0,
        costo_produccion = 0,
        proteccion_pct = 0,
        ingredientes = [],
    } = data;

    let sumaInsumos = 0;
    const detalle = [];
    for (const ing of ingredientes) {
        const { producto_id, cantidad } = ing;
        if (!producto_id || cantidad === undefined || cantidad === null) {
            throw new Error("Cada ingrediente requiere 'producto_id' y 'cantidad'");
        }
        const p = await pool.query(
            "SELECT producto, costo_unitario FROM productos WHERE id = $1 AND empresa_id = $2",
            [producto_id, empresa_id]
        );
        if (!p.rows[0]) throw new Error(`El producto ${producto_id} no existe en la empresa ${empresa_id}`);
        const costo_final = Number(cantidad) * Number(p.rows[0].costo_unitario);
        sumaInsumos += costo_final;
        detalle.push({
            producto_id, producto: p.rows[0].producto, cantidad,
            costo_unitario: Number(p.rows[0].costo_unitario),
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
