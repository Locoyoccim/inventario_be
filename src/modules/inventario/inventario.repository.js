import pool from "../../config/db.js";

const QUERIES = {
    SELECT_ALL: `
        SELECT
            i.id,
            i.producto_id,
            p.producto,
            i.stock_actual,
            i.stock_minimo,
            i.updated_at
        FROM inventario i
        INNER JOIN productos p ON p.id = i.producto_id
        WHERE p.empresa_id = $1
        ORDER BY i.id ASC;
    `,
    SELECT_BY_ID: `
        SELECT
            i.id,
            i.producto_id,
            p.producto,
            i.stock_actual,
            i.stock_minimo,
            i.updated_at
        FROM inventario i
        INNER JOIN productos p ON p.id = i.producto_id
        WHERE i.id = $1 AND p.empresa_id = $2;
    `,
};

export default class InventarioRepository {
    async findAll(empresa_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener inventario: ${error.message}`);
        }
    }

    async findById(id, empresa_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener inventario por ID: ${error.message}`);
        }
    }
}
