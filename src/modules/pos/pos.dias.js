// Qué tanto cubre el POS un día de negocio. Evita contar dos veces la misma venta: la importada
// del CSV de Toteat (o capturada a mano en el cierre del día) y la cobrada en el POS.

// `db` es el pool o un client de una transacción abierta.
export async function usoPosDia(db, empresa_id, fecha) {
    const r = await db.query(
        `SELECT
            (SELECT COUNT(*)::int FROM pos_cuentas WHERE empresa_id = $1 AND fecha_negocio = $2 AND estado = 'PAGADA') AS pagadas,
            (SELECT COUNT(*)::int FROM pos_turnos WHERE empresa_id = $1 AND fecha_negocio = $2 AND estado = 'ABIERTO') AS turnos_abiertos,
            (SELECT COUNT(*)::int FROM pos_turnos WHERE empresa_id = $1 AND fecha_negocio = $2) AS turnos`,
        [empresa_id, fecha],
    );
    const { pagadas, turnos_abiertos, turnos } = r.rows[0];
    return {
        pagadas,
        turnos,
        // Una caja abierta ese día cobrará más tarde: importar el CSV ahora también duplicaría.
        bloquea_importacion: pagadas > 0 || turnos_abiertos > 0,
        bloquea_cierre_manual: turnos > 0,
    };
}

// ¿Ya se importó el CSV de ese día? El POS lo avisa al abrir caja (no bloquea: la operación no se detiene).
export async function diaImportadoCsv(db, empresa_id, fecha) {
    const r = await db.query("SELECT 1 FROM venta_diaria WHERE empresa_id = $1 AND fecha = $2", [empresa_id, fecha]);
    return r.rowCount > 0;
}
