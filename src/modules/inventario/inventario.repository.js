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
    INSERT: `
        INSERT INTO inventario (producto_id, stock_actual, stock_minimo, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        RETURNING id, producto_id, stock_actual, stock_minimo, updated_at;
    `,
    UPDATE: `
        UPDATE inventario i
        SET
            producto_id = $1,
            stock_actual = $2,
            stock_minimo = $3,
            updated_at = CURRENT_TIMESTAMP
        FROM productos current_producto, productos new_producto
        WHERE i.id = $4
            AND i.producto_id = current_producto.id
            AND current_producto.empresa_id = $5
            AND new_producto.id = $1
            AND new_producto.empresa_id = $5
        RETURNING i.id, i.producto_id, i.stock_actual, i.stock_minimo, i.updated_at;
    `,
    DELETE: `
        DELETE FROM inventario i
        USING productos p
        WHERE i.id = $1
            AND i.producto_id = p.id
            AND p.empresa_id = $2
        RETURNING i.id;
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

    async create(data) {
        const { producto_id, stock_actual, stock_minimo } = data;
        try {
            const result = await pool.query(QUERIES.INSERT, [
                producto_id,
                stock_actual,
                stock_minimo,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al crear inventario: ${error.message}`);
        }
    }

    async update(id, empresa_id, data) {
        const { producto_id, stock_actual, stock_minimo } = data;
        try {
            const result = await pool.query(QUERIES.UPDATE, [
                producto_id,
                stock_actual,
                stock_minimo,
                id,
                empresa_id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al actualizar inventario: ${error.message}`);
        }
    }

    async remove(id, empresa_id) {
        try {
            const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al eliminar inventario: ${error.message}`);
        }
    }
}
