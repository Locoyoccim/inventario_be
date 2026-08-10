import pool from "../../config/db.js";

// Consultas SQL
const QUERIES = {
    SELECT_ALL: `
    SELECT
        r.id,
        r.receta_id,
        p.producto,
        r.cantidad,
        r.costo_unitario,
        r.costo_final
    FROM receta_detalle r
    INNER JOIN productos p ON p.id = r.producto_id
    WHERE r.receta_id = $1
    ORDER BY r.id ASC;
`,
    SELECT_BY_ID: `
    SELECT
        r.id,
        r.receta_id,
        p.producto,
        r.cantidad,
        r.costo_unitario,
        r.costo_final
    FROM receta_detalle r
    INNER JOIN productos p ON p.id = r.producto_id
    WHERE r.id = $1 AND r.receta_id = $2;
`,
    UPDATE: `
    UPDATE receta_detalle r
    SET
        producto_id = $1,
        cantidad = $2,
        costo_unitario = p.costo_unitario
    FROM productos p
    WHERE r.id = $3
        AND r.receta_id = $4
        AND p.id = $1
    RETURNING
        r.id,
        r.receta_id,
        p.producto,
        r.cantidad,
        r.costo_unitario,
        r.costo_final;
`,
    DELETE: `
    DELETE FROM receta_detalle
    WHERE id = $1 AND receta_id = $2;
`,
    INSERT: `
    WITH producto_data AS (
        SELECT id, producto, costo_unitario
        FROM productos
        WHERE id = $3
    ),
    inserted AS (
        INSERT INTO receta_detalle (
            receta_id,
            producto_id,
            cantidad,
            costo_unitario
        )
        SELECT
            $1,
            p.id,
            $2,
            p.costo_unitario
        FROM producto_data p
        RETURNING id, receta_id, producto_id, cantidad, costo_unitario, costo_final
    )
    SELECT
        i.id,
        i.receta_id,
        p.producto,
        i.cantidad,
        i.costo_unitario,
        i.costo_final
    FROM inserted i
    INNER JOIN producto_data p ON p.id = i.producto_id;
`,
};

export default class RecetaDetalleRepository {
    async findAll(receta_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL, [receta_id]);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener detalles de receta: ${error.message}`);
        }
    }

    async findById(receta_id, id) {
        try {
            const result = await pool.query(QUERIES.SELECT_BY_ID, [id, receta_id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(
                `Error al obtener detalle de receta por ID: ${error.message}`,
            );
        }
    }

    async create(receta_id, data) {
        const { producto_id, cantidad } = data;
        try {
            if (!producto_id || cantidad === undefined || cantidad === null) {
                throw new Error("producto_id y cantidad son requeridos");
            }

            const result = await pool.query(QUERIES.INSERT, [
                receta_id,
                cantidad,
                producto_id,
            ]);

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al crear detalle de receta: ${error.message}`);
        }
    }

    async update(receta_id, id, data) {
        const { producto_id, cantidad } = data;
        try {
            if (!producto_id || cantidad === undefined || cantidad === null) {
                throw new Error("producto_id y cantidad son requeridos");
            }

            const result = await pool.query(QUERIES.UPDATE, [
                producto_id,
                cantidad,
                id,
                receta_id,
            ]);

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al actualizar detalle de receta: ${error.message}`);
        }
    }

    async remove(receta_id, id) {
        try {
            await pool.query(QUERIES.DELETE, [id, receta_id]);
            return { message: "Detalle de receta eliminado correctamente" };
        } catch (error) {
            throw new Error(`Error al eliminar detalle de receta: ${error.message}`);
        }
    }
}
