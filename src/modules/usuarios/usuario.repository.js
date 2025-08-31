import pool from "../../config/db.js";

export default class UsuarioRepository {
    async findAll() {
        const result = await pool.query(`
            SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
                   r.nombre AS rol, e.nombre AS empresa
            FROM usuarios u
            JOIN roles r ON u.role_id = r.id
            JOIN empresas e ON u.empresa_id = e.id
        `);
        return result.rows;
    }

    async findById(id) {
        const result = await pool.query(
            `
            SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
                   r.nombre AS rol, e.nombre AS empresa
            FROM usuarios u
            JOIN roles r ON u.role_id = r.id
            JOIN empresas e ON u.empresa_id = e.id
            WHERE u.id = $1
        `,
            [id]
        );
        return result.rows[0];
    }
}
