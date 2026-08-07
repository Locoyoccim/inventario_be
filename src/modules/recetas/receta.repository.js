import pool from "../../config/db.js";

// Consultas SQL
const QUERIES = {
    SELECT_ALL: `
    SELECT
        r.id,
        r.nombre,
        r.categoria,
        r.precio_venta,
        r.costo_total,
        r.margen,
        r.activo,
        r.created_at,
        r.empresa_id
    FROM recetas r
    WHERE r.empresa_id = $1
    ORDER BY r.id ASC;
`,
    SELECT_BY_ID: `
    SELECT
        r.id,
        r.nombre,
        r.categoria,
        r.precio_venta,
        r.costo_total,
        r.margen,
        r.activo,
        r.created_at,
        r.empresa_id
    FROM recetas r
    WHERE r.id = $1 AND r.empresa_id = $2;
`,
    UPDATE: `
    UPDATE recetas
    SET nombre = $1, categoria = $2, precio_venta = $3, costo_total = $4, margen = $5, activo = $6
    WHERE id = $7 AND empresa_id = $8;
`,
    DELETE: `
    DELETE FROM recetas
    WHERE id = $1 AND empresa_id = $2;
`,
    INSERT: `
    INSERT INTO recetas (nombre, categoria, precio_venta, costo_total, margen, activo, empresa_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
`,

};

export default class RecetaRepository {
    async findAll(empresa_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener recetas: ${error.message}`);
        }
    }

    async findById(empresa_id, id) {
        try {
            const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener receta por ID: ${error.message}`);
        }
    }

    async create(empresa_id, data) {
        const { nombre, categoria, precio_venta, costo_total, margen, activo } = data;
        try {
            const result = await pool.query(QUERIES.INSERT, [nombre, categoria, precio_venta, costo_total, margen, activo, empresa_id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al crear receta: ${error.message}`);
        }
    }

    async update(empresa_id, id, data) {
        const { nombre, categoria, precio_venta, costo_total, margen, activo } = data;
        try {
            await pool.query(QUERIES.UPDATE, [nombre, categoria, precio_venta, costo_total, margen, activo, id, empresa_id]);
            return { message: "Receta actualizada correctamente" };
        } catch (error) {
            throw new Error(`Error al actualizar receta: ${error.message}`);
        }
    }

    async remove(empresa_id, id) {
        try {
            await pool.query(QUERIES.DELETE, [id, empresa_id]);
            return { message: "Receta eliminada correctamente" };
        } catch (error) {
            throw new Error(`Error al eliminar receta: ${error.message}`);
        }
    }   
}
