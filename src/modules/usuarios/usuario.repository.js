import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    SELECT_ALL: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.empresa_id = $1
        ORDER BY u.id ASC
    `,
    SELECT_BY_ID: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.empresa_id = $1 AND u.id = $2
    `,
    SELECT_PROFILE: `
        SELECT id, nombre, email, is_admin, is_owner, empresa_id
        FROM usuarios
        WHERE empresa_id = $1 AND id = $2
    `,
    SELECT_COUNT: `SELECT COUNT(*)::int AS total FROM usuarios`,
    SELECT_BY_EMAIL: `
        SELECT id, nombre, email, password_hash, is_admin, is_owner, role_id, empresa_id
        FROM usuarios
        WHERE lower(trim(email)) = lower(trim($1))
        ORDER BY id
        LIMIT 1
    `,
    INSERT: `
        INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email
    `,
    UPDATE: `
        WITH updated AS (
            UPDATE usuarios
            SET nombre = $1, codigo_ingreso = $2, puesto = $3,
                is_admin = $4, is_owner = $5, role_id = $6, empresa_id = $7
            WHERE id = $8 AND empresa_id = $7
            RETURNING *
        )
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner,
               u.role_id, u.empresa_id, r.nombre AS rol
        FROM updated u
        LEFT JOIN roles r ON u.role_id = r.id
    `,
    DELETE: `DELETE FROM usuarios WHERE empresa_id = $1 AND id = $2 RETURNING id`,
};

export default class UsuarioRepository {
    async findAll(empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
        return result.rows;
    }

    async findById(empresa_id, id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        const result = await pool.query(QUERIES.SELECT_BY_ID, [empresa_id, id]);
        return result.rows[0];
    }

    async create(empresa_id, userData) {
        const {
            nombre, codigo_ingreso, puesto,
            is_admin = false, is_owner = false, role_id,
            email = null, password_hash = null,
        } = userData;

        if (!nombre || !codigo_ingreso || !puesto || !role_id || !empresa_id) {
            throw ApiError.badRequest("Faltan campos requeridos (nombre, codigo_ingreso, puesto, role_id)");
        }

        const result = await pool.query(QUERIES.INSERT, [
            nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, password_hash,
        ]);
        return result.rows[0];
    }

    async update(empresa_id, id, userData) {
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        if (!id) throw ApiError.badRequest("ID es requerido");
        const { nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id } = userData;
        const result = await pool.query(QUERIES.UPDATE, [
            nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, id,
        ]);
        return result.rows[0];
    }

    async remove(empresa_id, id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        const result = await pool.query(QUERIES.DELETE, [empresa_id, id]);
        return result.rows[0];
    }

    async findProfile(empresa_id, id) {
        const result = await pool.query(QUERIES.SELECT_PROFILE, [empresa_id, id]);
        return result.rows[0];
    }

    async findByEmail(email) {
        const result = await pool.query(QUERIES.SELECT_BY_EMAIL, [email]);
        return result.rows[0];
    }

    async countAll() {
        const result = await pool.query(QUERIES.SELECT_COUNT);
        return result.rows[0].total;
    }
}
