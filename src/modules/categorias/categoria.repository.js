import pool from "../../config/db.js";

const QUERIES = {
    LIST: `SELECT id, empresa_id, nombre, activo FROM categorias WHERE empresa_id = $1 ORDER BY nombre ASC`,
    INSERT: `INSERT INTO categorias (empresa_id, nombre) VALUES ($1, $2) RETURNING id, empresa_id, nombre, activo`,
    UPDATE: `UPDATE categorias SET nombre = $1 WHERE id = $2 AND empresa_id = $3 RETURNING id, empresa_id, nombre, activo`,
    DELETE: `DELETE FROM categorias WHERE id = $1 AND empresa_id = $2 RETURNING id`,
};

export default class CategoriaRepository {
    async findAll(empresa_id) {
        return (await pool.query(QUERIES.LIST, [empresa_id])).rows;
    }
    async create(empresa_id, { nombre }) {
        // Un nombre duplicado dispara 23505 -> el errorHandler responde 409.
        return (await pool.query(QUERIES.INSERT, [empresa_id, nombre])).rows[0];
    }
    async update(empresa_id, id, { nombre }) {
        return (await pool.query(QUERIES.UPDATE, [nombre, id, empresa_id])).rows[0];
    }
    async remove(empresa_id, id) {
        return (await pool.query(QUERIES.DELETE, [id, empresa_id])).rows[0];
    }
}
