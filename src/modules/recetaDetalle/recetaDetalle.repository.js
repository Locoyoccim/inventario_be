import pool from "../../config/db.js";
import { recalcularCostoTotal } from "../../utils/costeo.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    SELECT_ALL: `
    SELECT r.id, r.receta_id, r.producto_id, p.producto, p.unidad_medida, p.es_elaborado,
           r.cantidad, r.costo_unitario, r.costo_final
    FROM receta_detalle r
    INNER JOIN productos p ON p.id = r.producto_id
    WHERE r.receta_id = $1
    ORDER BY r.id ASC;`,
    SELECT_BY_ID: `
    SELECT r.id, r.receta_id, r.producto_id, p.producto, p.unidad_medida, p.es_elaborado,
           r.cantidad, r.costo_unitario, r.costo_final
    FROM receta_detalle r
    INNER JOIN productos p ON p.id = r.producto_id
    WHERE r.id = $1 AND r.receta_id = $2;`,
    UPDATE: `
    UPDATE receta_detalle r
    SET producto_id = $1, cantidad = $2, costo_unitario = p.costo_unitario
    FROM productos p, recetas rec
    WHERE r.id = $3 AND r.receta_id = $4 AND p.id = $1 AND rec.id = $4
        AND rec.empresa_id = p.empresa_id
    RETURNING r.id, r.receta_id, r.producto_id, p.producto, p.unidad_medida, p.es_elaborado, r.cantidad, r.costo_unitario, r.costo_final;`,
    DELETE: `DELETE FROM receta_detalle WHERE id = $1 AND receta_id = $2 RETURNING id;`,
    INSERT: `
    WITH producto_data AS (
        SELECT p.id, p.producto, p.unidad_medida, p.es_elaborado, p.costo_unitario
        FROM productos p
        JOIN recetas rec ON rec.empresa_id = p.empresa_id
        WHERE p.id = $3 AND rec.id = $1
    ),
    inserted AS (
        INSERT INTO receta_detalle (receta_id, producto_id, cantidad, costo_unitario)
        SELECT $1, p.id, $2, p.costo_unitario
        FROM producto_data p
        RETURNING id, receta_id, producto_id, cantidad, costo_unitario, costo_final
    )
    SELECT i.id, i.receta_id, i.producto_id, p.producto, p.unidad_medida, p.es_elaborado, i.cantidad, i.costo_unitario, i.costo_final
    FROM inserted i
    INNER JOIN producto_data p ON p.id = i.producto_id;`,
};

export default class RecetaDetalleRepository {
    async findAll(receta_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [receta_id]);
        return result.rows;
    }

    async findById(receta_id, id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id, receta_id]);
        return result.rows[0];
    }

    async create(receta_id, data) {
        const { producto_id, cantidad } = data;
        if (!producto_id || cantidad === undefined || cantidad === null) {
            throw ApiError.badRequest("producto_id y cantidad son requeridos");
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(QUERIES.INSERT, [receta_id, cantidad, producto_id]);
            const detalle = result.rows[0];
            if (detalle) await recalcularCostoTotal(client, receta_id);
            await client.query("COMMIT");
            return detalle;
        } catch (error) {
            await client.query("ROLLBACK");
            throw new Error(`Error al crear detalle de receta: ${error.message}`);
        } finally {
            client.release();
        }
    }

    async update(receta_id, id, data) {
        const { producto_id, cantidad } = data;
        if (!producto_id || cantidad === undefined || cantidad === null) {
            throw ApiError.badRequest("producto_id y cantidad son requeridos");
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(QUERIES.UPDATE, [producto_id, cantidad, id, receta_id]);
            const detalle = result.rows[0];
            if (detalle) await recalcularCostoTotal(client, receta_id);
            await client.query("COMMIT");
            return detalle;
        } catch (error) {
            await client.query("ROLLBACK");
            throw new Error(`Error al actualizar detalle de receta: ${error.message}`);
        } finally {
            client.release();
        }
    }

    async remove(receta_id, id) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(QUERIES.DELETE, [id, receta_id]);
            const detalle = result.rows[0];
            if (detalle) await recalcularCostoTotal(client, receta_id);
            await client.query("COMMIT");
            return detalle;
        } catch (error) {
            await client.query("ROLLBACK");
            throw new Error(`Error al eliminar detalle de receta: ${error.message}`);
        } finally {
            client.release();
        }
    }
}
