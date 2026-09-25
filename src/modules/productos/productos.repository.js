import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { propagarCostoInsumos } from "../../utils/costeo.js";

const QUERIES = {
    SELECT_BY_ID: `
        SELECT p.id, p.producto, p.unidad_medida, p.proveedor_id, prov.nombre AS proveedor, p.categoria, p.empresa_id,
               p.cantidad_presentacion, p.costo_presentacion, p.costo_unitario, p.es_elaborado, p.activo, p.compra_al_producir,
               i.stock_actual, i.stock_minimo
        FROM productos p
        LEFT JOIN proveedores prov ON prov.id = p.proveedor_id
        LEFT JOIN inventario i ON i.producto_id = p.id
        WHERE p.empresa_id = $2 AND p.id = $1
    `,
    EXISTS_PRODUCTO: `SELECT 1 FROM productos WHERE id = $1`,
    ES_ELABORADO: `SELECT es_elaborado FROM productos WHERE id = $1 AND empresa_id = $2`,
    INSERT_PRODUCTO: `
        INSERT INTO productos
        (producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, compra_al_producir)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, false))
        RETURNING id, producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario, activo, compra_al_producir
    `,
    INSERT_INVENTARIO: `
        INSERT INTO inventario (producto_id, stock_actual, stock_minimo, empresa_id, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING stock_actual, stock_minimo, updated_at
    `,
    UPDATE_PRODUCTO: `
        UPDATE productos
        SET producto = $1, unidad_medida = $2, proveedor_id = $3, categoria = $4,
            cantidad_presentacion = $5, costo_presentacion = $6, activo = COALESCE($9, activo),
            compra_al_producir = COALESCE($10, compra_al_producir)
        WHERE id = $7 AND empresa_id = $8
        RETURNING id, producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, costo_unitario, activo, compra_al_producir
    `,
    UPDATE_INVENTARIO_MINIMO: `
        UPDATE inventario
        SET stock_minimo = $1, updated_at = CURRENT_TIMESTAMP
        WHERE producto_id = $2
        RETURNING stock_actual, stock_minimo, updated_at
    `,
    // Soft-delete: nunca se borra físicamente (rompería FKs de historial).
    SOFT_DELETE: `UPDATE productos SET activo = false WHERE id = $1 AND empresa_id = $2 RETURNING id`,
};

export default class ProductoRepository {
    // Listado con filtros: q (nombre), categoria, bajo_minimo, incluir_inactivos.
    async findAll(empresa_id, { limit = 50, offset = 0, q = null, categoria = null, bajoMinimo = false, incluirInactivos = false } = {}) {
        const where = ["p.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (!incluirInactivos) where.push("p.activo = true");
        if (q) { where.push(`p.producto ILIKE $${i}`); params.push(`%${q}%`); i++; }
        if (categoria) { where.push(`p.categoria = $${i}`); params.push(categoria); i++; }
        if (bajoMinimo) where.push("i.stock_actual < i.stock_minimo");

        const sql = `
            SELECT p.id, p.producto, p.unidad_medida, p.proveedor_id, prov.nombre AS proveedor, p.categoria, p.empresa_id,
                   p.cantidad_presentacion, p.costo_presentacion, p.costo_unitario, p.es_elaborado, p.activo, p.compra_al_producir,
                   i.stock_actual, i.stock_minimo,
                   COUNT(*) OVER()::int AS total
            FROM productos p
            LEFT JOIN proveedores prov ON prov.id = p.proveedor_id
            LEFT JOIN inventario i ON i.producto_id = p.id
            WHERE ${where.join(" AND ")}
            ORDER BY p.id ASC
            LIMIT $${i} OFFSET $${i + 1}
        `;
        params.push(limit, offset);
        const result = await pool.query(sql, params);
        const total = result.rows[0]?.total ?? 0;
        const rows = result.rows.map(({ total, ...r }) => r);
        return { rows, total };
    }

    async findById(id, empresa_id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
        return result.rows[0];
    }

    async exitsProducto(id) {
        const result = await pool.query(QUERIES.EXISTS_PRODUCTO, [id]);
        return result.rowCount > 0;
    }

    // Dónde se usa un producto: recetas que lo llevan y mapeos POS que lo referencian.
    async uso(empresa_id, id) {
        const recetas = (await pool.query(
            `SELECT DISTINCT r.id, r.nombre FROM receta_detalle rd JOIN recetas r ON r.id = rd.receta_id
             WHERE rd.producto_id = $1 AND r.empresa_id = $2 ORDER BY r.nombre`,
            [id, empresa_id]
        )).rows;
        const mapeos_pos = (await pool.query(
            `SELECT id, nombre_pos FROM pos_map WHERE producto_id = $1 AND empresa_id = $2 ORDER BY nombre_pos`,
            [id, empresa_id]
        )).rows;
        return { recetas, mapeos_pos };
    }

    async createProducto(data, empresa_id) {
        const {
            producto, stock_actual, stock_minimo, unidad_medida,
            proveedor_id, categoria, cantidad_presentacion, costo_presentacion, compra_al_producir,
        } = data;
        const camposRequeridos = {
            producto, stock_actual, stock_minimo, unidad_medida,
            proveedor_id, categoria, cantidad_presentacion, costo_presentacion, empresa_id,
        };
        for (const [campo, valor] of Object.entries(camposRequeridos)) {
            if (valor === undefined || valor === null || valor === "") {
                throw ApiError.badRequest(`El campo '${campo}' es requerido`);
            }
        }

        // Proveedor: debe existir en la empresa y estar activo (B-A3)
        const prov = await pool.query(
            "SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2",
            [proveedor_id, empresa_id]
        );
        if (prov.rowCount === 0) throw ApiError.badRequest("El proveedor no existe en la empresa");
        if (prov.rows[0].activo === false) throw ApiError.badRequest("El proveedor está inactivo");

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const productoResult = await client.query(QUERIES.INSERT_PRODUCTO, [
                producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion,
                compra_al_producir ?? null,
            ]);
            const nuevoProducto = productoResult.rows[0];
            const inventarioResult = await client.query(QUERIES.INSERT_INVENTARIO, [
                nuevoProducto.id, stock_actual, stock_minimo, empresa_id,
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
        { producto, stock_minimo, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion, activo, compra_al_producir },
        empresa_id
    ) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");

        const elab = await pool.query(QUERIES.ES_ELABORADO, [id, empresa_id]);
        if (elab.rows[0]?.es_elaborado) {
            throw ApiError.badRequest("Producto elaborado: edítalo desde su receta (rendimiento/costo se recalculan solos)");
        }

        const camposRequeridos = {
            producto, stock_minimo, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion,
        };
        for (const [campo, valor] of Object.entries(camposRequeridos)) {
            if (valor === undefined || valor === null || valor === "") {
                throw ApiError.badRequest(`El campo '${campo}' es requerido`);
            }
        }

        // Proveedor: solo se valida si CAMBIA; se permite conservar el actual aunque esté inactivo (B-A3)
        const actual = await pool.query(
            "SELECT proveedor_id FROM productos WHERE id = $1 AND empresa_id = $2",
            [id, empresa_id]
        );
        const proveedorActual = actual.rows[0]?.proveedor_id;
        if (proveedor_id != null && Number(proveedor_id) !== Number(proveedorActual)) {
            const prov = await pool.query(
                "SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2",
                [proveedor_id, empresa_id]
            );
            if (prov.rowCount === 0) throw ApiError.badRequest("El proveedor no existe en la empresa");
            if (prov.rows[0].activo === false) throw ApiError.badRequest("El proveedor está inactivo");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const productoResult = await client.query(QUERIES.UPDATE_PRODUCTO, [
                producto, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion,
                id, empresa_id, activo ?? null, compra_al_producir ?? null,
            ]);
            const productoActualizado = productoResult.rows[0];
            if (!productoActualizado) {
                await client.query("ROLLBACK");
                return null;
            }
            // stock_actual NO se toca aquí: solo por /movimientos (GAP-06)
            const inventarioResult = await client.query(QUERIES.UPDATE_INVENTARIO_MINIMO, [stock_minimo, id]);
            // Si cambió el costo (presentación o cantidad), refresca las recetas que lo usan
            const recetasActualizadas = await propagarCostoInsumos(client, [id]);
            await client.query("COMMIT");
            return {
                ...productoActualizado,
                ...inventarioResult.rows[0],
                recetas_actualizadas: recetasActualizadas.length,
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // Desactiva (soft-delete). No borra físicamente para conservar el historial.
    async deleteProducto(id, empresa_id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        const elab = await pool.query(QUERIES.ES_ELABORADO, [id, empresa_id]);
        if (elab.rows[0]?.es_elaborado) {
            throw ApiError.badRequest("Producto elaborado: gestiónalo desde su receta");
        }
        const result = await pool.query(QUERIES.SOFT_DELETE, [id, empresa_id]);
        return result.rows[0];
    }
}
