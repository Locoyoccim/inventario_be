import pool from "../../config/db.js";

// Consultas SQL
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
    INSERT: `
        INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id
    `,
    UPDATE: `
        WITH updated AS (
    UPDATE usuarios
    SET nombre = $1,
        codigo_ingreso = $2,
        puesto = $3,
        is_admin = $4,
        is_owner = $5,
        role_id = $6,
        empresa_id = $7
    WHERE id = $8
      AND empresa_id = $7
    RETURNING *)
    SELECT
        u.id,
        u.nombre,
        u.codigo_ingreso,
        u.puesto,
        u.is_admin,
        u.is_owner,
        u.role_id,
        u.empresa_id,
        r.nombre AS rol
    FROM updated u
    LEFT JOIN roles r ON u.role_id = r.id;
        `,
    DELETE: `DELETE FROM usuarios WHERE empresa_id = $1 AND id = $2 RETURNING id`,
};

export default class UsuarioRepository {
    async findAll(empresa_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener usuarios: ${error.message}`);
        }
    }

    async findById(empresa_id, id) {
        try {
            if (!id) throw new Error("ID es requerido");
            if (!empresa_id) throw new Error("empresa_id es requerido");

            const result = await pool.query(QUERIES.SELECT_BY_ID, [empresa_id, id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener usuario por ID: ${error.message}`);
        }
    }

    async create(empresa_id, userData) {
        try {
            const {
                nombre,
                codigo_ingreso,
                puesto,
                is_admin = false,
                is_owner = false,
                role_id,
            } = userData;

            // Validaciones básicas
            if (!nombre || !codigo_ingreso || !puesto || !role_id || !empresa_id) {
                throw new Error("Faltan campos requeridos");
            }

            const result = await pool.query(QUERIES.INSERT, [
                nombre,
                codigo_ingreso,
                puesto,
                is_admin,
                is_owner,
                role_id,
                empresa_id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al crear usuario: ${error.message}`);
        }
    }

    async update(empresa_id, id, userData) {
        if (!empresa_id) throw new Error("empresa_id es requerido");
        if (!id) throw new Error("ID es requerido");
        try {
            const {
                nombre,
                codigo_ingreso,
                puesto,
                is_admin,
                is_owner,
                role_id,
            } = userData;

            const result = await pool.query(QUERIES.UPDATE, [
                nombre,
                codigo_ingreso,
                puesto,
                is_admin,
                is_owner,
                role_id,
                empresa_id,
                id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al actualizar usuario: ${error.message}`);
        }
    }

    async remove(empresa_id, id) {
        try {
            if (!id) throw new Error("ID es requerido");

            const result = await pool.query(QUERIES.DELETE, [empresa_id, id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al eliminar usuario: ${error.message}`);
        }
    }
}
