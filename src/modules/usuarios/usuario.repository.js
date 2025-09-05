import pool from "../../config/db.js";

// Consultas SQL
const QUERIES = {
    SELECT_ALL: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               r.nombre AS rol, e.nombre AS empresa
        FROM usuarios u
        JOIN roles r ON u.role_id = r.id
        JOIN empresas e ON u.empresa_id = e.id
        ORDER BY u.id ASC
    `,
    SELECT_BY_ID: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               r.nombre AS rol, e.nombre AS empresa
        FROM usuarios u
        JOIN roles r ON u.role_id = r.id
        JOIN empresas e ON u.empresa_id = e.id
        WHERE u.id = $1
    `,
    INSERT: `
        INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id
    `,
    UPDATE: `
        UPDATE usuarios
        SET nombre = $1,
            codigo_ingreso = $2,
            puesto = $3,
            is_admin = $4,
            is_owner = $5,
            role_id = $6,
            empresa_id = $7
        WHERE id = $8
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id
    `,
    DELETE: `DELETE FROM usuarios WHERE id = $1 RETURNING id`,
};

export default class UsuarioRepository {
    async findAll() {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener usuarios: ${error.message}`);
        }
    }

    async findById(id) {
        try {
            if (!id) throw new Error("ID es requerido");

            const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener usuario por ID: ${error.message}`);
        }
    }

    async create(userData) {
        try {
            const {
                nombre,
                codigo_ingreso,
                puesto,
                is_admin = false,
                is_owner = false,
                role_id,
                empresa_id,
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

    async update(id, userData) {
        try {
            if (!id) throw new Error("ID es requerido");

            const {
                nombre,
                codigo_ingreso,
                puesto,
                is_admin,
                is_owner,
                role_id,
                empresa_id,
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

    async remove(id) {
        try {
            if (!id) throw new Error("ID es requerido");

            const result = await pool.query(QUERIES.DELETE, [id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al eliminar usuario: ${error.message}`);
        }
    }
}
