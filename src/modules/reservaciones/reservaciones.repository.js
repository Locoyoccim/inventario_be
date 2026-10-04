import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

const VIEW = `
    SELECT r.id, r.empresa_id, r.nombre_cliente, r.telefono_cliente, r.fecha, r.hora, r.personas,
           r.alergias, r.comentarios, r.estado, r.usuario_id, u.nombre AS usuario, r.created_at, r.updated_at,
           cu.id AS cuenta_id, cu.folio AS cuenta_folio, cu.estado AS cuenta_estado
    FROM reservaciones r
    LEFT JOIN usuarios u ON u.id = r.usuario_id
    -- La cuenta del POS que se abrió al sentarla (la más reciente que no se canceló).
    LEFT JOIN LATERAL (
        SELECT c.id, c.folio, c.estado FROM pos_cuentas c
        WHERE c.reservacion_id = r.id AND c.estado <> 'CANCELADA' ORDER BY c.id DESC LIMIT 1
    ) cu ON true`;

export default class ReservacionRepository {
    async getById(empresa_id, id) {
        const r = await pool.query(`${VIEW} WHERE r.id = $1 AND r.empresa_id = $2`, [id, empresa_id]);
        return r.rows[0];
    }

    async listar(empresa_id, { desde, hasta, estado }) {
        const where = ["r.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (desde) { where.push(`r.fecha >= $${i}`); params.push(desde); i++; }
        if (hasta) { where.push(`r.fecha <= $${i}`); params.push(hasta); i++; }
        if (estado) { where.push(`r.estado = $${i}`); params.push(estado); }
        const w = where.join(" AND ");
        const rows = (await pool.query(`${VIEW} WHERE ${w} ORDER BY r.fecha ASC, r.hora ASC, r.id ASC`, params)).rows;
        return rows;
    }

    async crear(empresa_id, data, usuario_id) {
        const { nombre_cliente, telefono_cliente, fecha, hora, personas, alergias = null, comentarios = null } = data;
        const r = await pool.query(
            `INSERT INTO reservaciones (empresa_id, nombre_cliente, telefono_cliente, fecha, hora, personas, alergias, comentarios, usuario_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [empresa_id, nombre_cliente, telefono_cliente, fecha, hora, personas, alergias, comentarios, usuario_id]
        );
        return await this.getById(empresa_id, r.rows[0].id);
    }

    async actualizar(empresa_id, id, data) {
        const actual = await this.getById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Reservación no encontrada");
        const { nombre_cliente, telefono_cliente, fecha, hora, personas, alergias = null, comentarios = null } = data;
        await pool.query(
            `UPDATE reservaciones
             SET nombre_cliente=$3, telefono_cliente=$4, fecha=$5, hora=$6, personas=$7, alergias=$8, comentarios=$9, updated_at=now()
             WHERE id=$1 AND empresa_id=$2`,
            [id, empresa_id, nombre_cliente, telefono_cliente, fecha, hora, personas, alergias, comentarios]
        );
        return await this.getById(empresa_id, id);
    }

    async cambiarEstado(empresa_id, id, estado) {
        const actual = await this.getById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Reservación no encontrada");
        await pool.query("UPDATE reservaciones SET estado=$3, updated_at=now() WHERE id=$1 AND empresa_id=$2", [id, empresa_id, estado]);
        return await this.getById(empresa_id, id);
    }

    async eliminar(empresa_id, id) {
        const r = await pool.query("DELETE FROM reservaciones WHERE id=$1 AND empresa_id=$2", [id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.notFound("Reservación no encontrada");
    }
}
