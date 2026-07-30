import pool from "../../config/db.js";

const QUERIES = {
    SELECT_ALL: `SELECT * FROM productos WHERE empresa_id = $1 ORDER BY id ASC`,
    SELECT_BY_ID: `SELECT * FROM productos WHERE empresa_id = $2 AND id = $1`,
    EXISTS_PRODUCTO: `SELECT 1 FROM productos WHERE id = $1`,
    INSERT_PRODUCTO: `
        INSERT INTO productos
        (producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario
    `,
    INSERT_INVENTARIO: `
        INSERT INTO inventario (producto_id, stock_actual, stock_minimo, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        RETURNING stock_actual, stock_minimo, updated_at
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
    async findAll(empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
        return result.rows;
    }

    async findById(id, empresa_id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
        return result.rows[0];
    }

    async exitsProducto(id) {
        const result = await pool.query(QUERIES.EXISTS_PRODUCTO, [id]);
        return result.rowCount > 0;
    }

    async createProducto(data, empresa_id) {
       const {
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
            cantidad_presentacion,
            costo_presentacion,
        } = data;
        const camposRequeridos = {
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
            empresa_id,
            cantidad_presentacion,
            costo_presentacion,
        };
        for (const [campo, valor] of Object.entries(camposRequeridos)) {
            if (valor === undefined || valor === null || valor === "") {
                throw new Error(`El campo '${campo}' es requerido`);
            }
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const productoResult = await client.query(QUERIES.INSERT_PRODUCTO, [
                producto,
                unidad_medida,
                proveedor_id,
                categoria,
                empresa_id,
                cantidad_presentacion,
                costo_presentacion,
            ]);
            const nuevoProducto = productoResult.rows[0];

            const inventarioResult = await client.query(QUERIES.INSERT_INVENTARIO, [
                nuevoProducto.id,
                stock_actual,
                stock_minimo,
            ]);

            await client.query("COMMIT");

            return { ...nuevoProducto, ...inventarioResult.rows[0] };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
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
        },
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

    async deleteProducto(id) {
        try {
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.DELETE, [id]);
            return result.rows[0];
        } catch (error) {
            throw new error(`Error al eliminar producto: ${error.message}`);
        }
    }
}
