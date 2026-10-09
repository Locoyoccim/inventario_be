// Bitácora de acciones administrativas (tabla admin_actividad, migración 052): SOLO inserción. La app no tiene UPDATE ni DELETE sobre ella.
// `empresa_id` es la empresa AFECTADA por la acción; va siempre explícito (no hay nada que leer aquí que dependa de un tenant).
const INSERT_ACTIVIDAD = `
    INSERT INTO admin_actividad
        (empresa_id, actor_id, actor_empresa_id, accion, objeto_tipo, objeto_id, detalle, ip, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    RETURNING id
`;

/** `db` es el pool o el cliente de una transacción en curso (así la fila entra o sale junto con la acción). */
export async function insertarActividad(db, f) {
    const r = await db.query(INSERT_ACTIVIDAD, [
        f.empresa_id,
        f.actor_id,
        f.actor_empresa_id,
        f.accion,
        f.objeto_tipo,
        f.objeto_id,
        JSON.stringify(f.detalle),
        f.ip,
        f.request_id,
    ]);
    return r.rows[0].id;
}
