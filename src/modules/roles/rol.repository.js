import pool from "../../config/db.js";

// Catálogo global de roles (no cuelga de empresa_id): cada empresa asigna sus usuarios
// Operativo a uno de estos roles vía usuarios.role_id.
const SELECT_ALL = `SELECT id, nombre, descripcion, clave, permisos FROM roles WHERE clave IS NOT NULL ORDER BY id ASC`;

export default class RolRepository {
    async findAll() {
        return (await pool.query(SELECT_ALL)).rows;
    }
}
