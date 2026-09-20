import pool from "../../config/db.js";

const QUERIES = {
    SELECT_ALL: `
        SELECT p.id, p.producto, p.unidad_medida, prov.nombre AS proveedor, p.categoria, p.empresa_id,
               p.cantidad_presentacion, p.costo_presentacion, p.costo_unitario
        FROM productos p
        LEFT JOIN proveedores prov ON prov.id = p.proveedor_id
        WHERE p.empresa_id = $1
        ORDER BY p.id ASC
    `,
    SELECT_BY_ID: `
        SELECT p.id, p.producto, p.unidad_medida, prov.nombre AS proveedor, p.categoria, p.empresa_id,
               p.cantidad_presentacion, p.costo_presentacion, p.costo_unitario
        FROM productos p
        LEFT JOIN proveedores prov ON prov.id = p.proveedor_id
        WHERE p.empresa_id = $2 AND p.id = $1
    `,
    EXISTS_PRODUCTO: `SELECT 1 FROM productos WHERE id = $1`,
    INSERT_PRODUCTO: `
        INSERT INTO productos
        (producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario
    `,
    INSERT_INVENTARIO: `
        INSERT INTO inventario (producto_id, stock_actual, stock_minimo, empresa_id, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING stock_actual, stock_minimo, updated_at
    `,
    UPDATE_PRODUCTO: `
        UPDATE productos
        SET producto = $1, unidad_medida = $2, proveedor_id = $3, categoria = $4, cantidad_presentacion = $5, costo_presentacion = $6
        WHERE id = $7 AND empresa_id = $8
        RETURNING id, producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario
    `,
    UPDATE_INVENTARIO: `
        UPDATE inventario
        SET stock_actual = $1, stock_minimo = $2, updated_at = CURRENT_TIMESTAMP
        WHERE producto_id = $3
        RETURNING stock_actual, stock_minimo, updated_at
    `,
    DELETE: `DELETE FROM productos WHERE id = $1 AND empresa_id = $2 RETURNING id`,
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
            cantidad_presentacion,
            costo_presentacion,
            empresa_id,
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
                empresa_id,
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
            cantidad_presentacion,
            costo_presentacion,
        },
        empresa_id
    ) {
        if (!id) throw new Error("ID es requerido");
        if (!empresa_id) throw new Error("empresa_id es requerido");

        const camposRequeridos = {
            producto,
            stock_actual,
            stock_minimo,
            unidad_medida,
            proveedor_id,
            categoria,
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

            const productoResult = await client.query(QUERIES.UPDATE_PRODUCTO, [
                producto,
                unidad_medida,
                proveedor_id,
                categoria,
                cantidad_presentacion,
                costo_presentacion,
                id,
                empresa_id,
            ]);
            const productoActualizado = productoResult.rows[0];

            if (!productoActualizado) {
                await client.query("ROLLBACK");
                return null;
            }

            const inventarioResult = await client.query(QUERIES.UPDATE_INVENTARIO, [
                stock_actual,
                stock_minimo,
                id,
            ]);

            await client.query("COMMIT");

            return { ...productoActualizado, ...inventarioResult.rows[0] };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteProducto(id, empresa_id) {
        if (!id) throw new Error("ID es requerido");
        if (!empresa_id) throw new Error("empresa_id es requerido");
        const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
        return result.rows[0];
    }
}
