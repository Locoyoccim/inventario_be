// El CSV de Toteat ya no se importa (se retiró), pero las ventas ya importadas siguen en venta_diaria y
// Finanzas / «Ventas por receta» las leen. Las pruebas de esa lectura siembran ese historial directo en la base.

/** lineas: [{ receta_id | producto_id, cantidad, precio_unitario, nombre_pos?, tipo? }] (sin ninguno de los dos ids = SIN_MAPEO) */
export async function sembrarVentaCsv(pool, empresa_id, fecha, lineas) {
    const unidades = lineas.reduce((s, l) => s + Number(l.cantidad), 0);
    const { id } = (await pool.query(
        "INSERT INTO venta_diaria (empresa_id, fecha, total_lineas, total_unidades) VALUES ($1,$2,$3,$4) RETURNING id",
        [empresa_id, fecha, lineas.length, unidades],
    )).rows[0];
    for (const l of lineas) {
        await pool.query(
            `INSERT INTO venta_diaria_detalle (venta_diaria_id, nombre_pos, cantidad, tipo, receta_id, producto_id, precio_unitario)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, l.nombre_pos ?? "venta", l.cantidad, l.tipo ?? (l.receta_id ? "RECETA" : l.producto_id ? "INSUMO" : "SIN_MAPEO"), l.receta_id ?? null, l.producto_id ?? null, l.precio_unitario ?? null],
        );
    }
    return id;
}

export const borrarVentaCsv = (pool, empresa_id, fecha) => pool.query("DELETE FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2", [empresa_id, fecha]);
