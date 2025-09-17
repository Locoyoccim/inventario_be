import pool from "../../config/db.js";

const QUERIES = {
    SELECT_ALL: `SELECT * FROM productos ORDER BY id ASC`,
    SELECT_BY_ID: `SELECT * FROM productos WHERE id = $1`,
    EXISTS_PRODUCTO: `SELECT 1 FROM productos WHERE id = $1`,
    INSERT: `
        INSERT INTO productos 
        (producto, stock_actual, stock_minimo, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, producto, stock_actual, stock_minimo, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario
    `,
    UPDATE: `
        UPDATE productos 
        SET producto = $1, stock_actual = $2, stock_minimo = $3, unidad_medida = $4, proveedor_id = $5, categoria = $6, empresa_id = $7, cantidad_presentacion = $8, costo_presentacion = $9, costo_unitario = $10
        WHERE id = $11
        RETURNING id, producto, stock_actual, stock_minimo, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario
    `,
    DELETE: `DELETE FROM productos WHERE id = $1 RETURNING id`,
};

export default class ProductoRepository {
    async findAll() {
        const result = await pool.query(QUERIES.SELECT_ALL);
        return result.rows;
    }

    async findById(id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
        return result.rows[0];
    }

    async exitsProducto(id) {
        const result = await pool.query(QUERIES.EXISTS_PRODUCTO, [id]);
        return result.rowCount > 0;
    }

    async createProducto({
        producto,
        stock_actual,
        stock_minimo,
        unidad_medida,
        proveedor_id,
        categoria,
        empresa_id,
        cantidad_presentacion,
        costo_presentacion,
        costo_unitario,
    }) {
        if (
            !producto ||
            !stock_actual ||
            !stock_minimo ||
            !unidad_medida ||
            !proveedor_id ||
            !categoria ||
            !empresa_id ||
            !cantidad_presentacion ||
            !costo_presentacion ||
            !costo_unitario
        ) {
            throw new Error("Todos los campos son requeridos");
        }

        const values = [
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
            empresa_id,
            cantidad_presentacion,
            costo_presentacion,
            costo_unitario,
        ];
        const result = await pool.query(QUERIES.INSERT, values);
        return result.rows[0];
    }

    async updateProducto(
        id,
        {
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
            empresa_id,
            cantidad_presentacion,
            costo_presentacion,
            costo_unitario,
        }
    ) {
        if (!id) throw new Error("ID es requerido");
        if (
            !producto ||
            !stock_actual ||
            !stock_minimo ||
            !unidad_medida ||
            !proveedor_id ||
            !categoria ||
            !empresa_id ||
            !cantidad_presentacion ||
            !costo_presentacion ||
            !costo_unitario
        ) {
            throw new Error("Todos los campos son requeridos");
        }

        const values = [
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
            empresa_id,
            cantidad_presentacion,
            costo_presentacion,
            costo_unitario,
            id,
        ];
        const result = await pool.query(QUERIES.UPDATE, values);
        return result.rows[0];
    }

    async removeProducto(id) {
        try {
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.DELETE, [id]);
            return result.rows[0];
        } catch (error) {
            throw new error(`Error al eliminar producto: ${error.message}`);
        }
    }
}
