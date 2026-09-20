import pool from "../../config/db.js";
import { recalcularCostoTotal } from "../../utils/costeo.js";

const QUERIES = {
    SELECT_ALL: `
    SELECT id, nombre, categoria, precio_venta, costo_total, margen, activo,
           created_at, empresa_id, costo_produccion, proteccion_pct
    FROM recetas
    WHERE empresa_id = $1
    ORDER BY id ASC;`,
    SELECT_BY_ID: `
    SELECT id, nombre, categoria, precio_venta, costo_total, margen, activo,
           created_at, empresa_id, costo_produccion, proteccion_pct
    FROM recetas
    WHERE id = $1 AND empresa_id = $2;`,
    EXISTS_RECETA: `SELECT 1 FROM recetas WHERE id = $1;`,
    UPDATE_HEADER: `
    UPDATE recetas
    SET nombre = $1, categoria = $2, precio_venta = $3, activo = $4,
        costo_produccion = $5, proteccion_pct = $6
    WHERE id = $7 AND empresa_id = $8
    RETURNING id;`,
    DELETE: `DELETE FROM recetas WHERE id = $1 AND empresa_id = $2 RETURNING id;`,
    INSERT: `
    INSERT INTO recetas (nombre, categoria, precio_venta, costo_total, activo, empresa_id, costo_produccion, proteccion_pct)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;`,
};

export default class RecetaRepository {
    async findAll(empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
        return result.rows;
    }

    async findById(empresa_id, id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
        return result.rows[0];
    }

    async existsReceta(id) {
        const result = await pool.query(QUERIES.EXISTS_RECETA, [id]);
        return result.rowCount > 0;
    }

    async create(empresa_id, data) {
        const {
            nombre, categoria, precio_venta,
            costo_total = 0, activo = true,
            costo_produccion = 0, proteccion_pct = 0,
        } = data;
        const result = await pool.query(QUERIES.INSERT, [
            nombre, categoria, precio_venta, costo_total, activo, empresa_id,
            costo_produccion, proteccion_pct,
        ]);
        return result.rows[0];
    }

    // Actualiza el encabezado y recalcula costo_total con la fórmula única.
    async update(empresa_id, id, data) {
        const {
            nombre, categoria, precio_venta, activo = true,
            costo_produccion = 0, proteccion_pct = 0,
        } = data;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const upd = await client.query(QUERIES.UPDATE_HEADER, [
                nombre, categoria, precio_venta, activo,
                costo_produccion, proteccion_pct, id, empresa_id,
            ]);
            if (!upd.rows[0]) {
                await client.query("ROLLBACK");
                return null;
            }
            const receta = await recalcularCostoTotal(client, id);
            await client.query("COMMIT");
            return receta;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async remove(empresa_id, id) {
        const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
        return result.rows[0];
    }

    // Crea la receta y todo su escandallo en UNA transacción. Usa la fórmula única.
    // data: { nombre, categoria, precio_venta, activo?, costo_produccion?, proteccion_pct?, ingredientes: [{producto_id, cantidad}] }
    async createConDetalle(empresa_id, data) {
        const {
            nombre, categoria, precio_venta, activo = true,
            costo_produccion = 0, proteccion_pct = 0, ingredientes = [],
        } = data;
        if (!Array.isArray(ingredientes) || ingredientes.length === 0) {
            throw new Error("Se requiere al menos un ingrediente en 'ingredientes'");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const recRes = await client.query(QUERIES.INSERT, [
                nombre, categoria, precio_venta, 0, activo, empresa_id,
                costo_produccion, proteccion_pct,
            ]);
            const receta = recRes.rows[0];

            const detalles = [];
            for (const ing of ingredientes) {
                const { producto_id, cantidad } = ing;
                if (!producto_id || cantidad === undefined || cantidad === null) {
                    throw new Error("Cada ingrediente requiere 'producto_id' y 'cantidad'");
                }
                const prod = await client.query(
                    "SELECT costo_unitario, producto FROM productos WHERE id = $1 AND empresa_id = $2",
                    [producto_id, empresa_id]
                );
                if (!prod.rows[0]) {
                    throw new Error(`El producto ${producto_id} no existe en la empresa ${empresa_id}`);
                }
                const det = await client.query(
                    `INSERT INTO receta_detalle (receta_id, producto_id, cantidad, costo_unitario)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id, receta_id, producto_id, cantidad, costo_unitario, costo_final`,
                    [receta.id, producto_id, cantidad, prod.rows[0].costo_unitario]
                );
                detalles.push({ ...det.rows[0], producto: prod.rows[0].producto });
            }

            const recetaFinal = await recalcularCostoTotal(client, receta.id);
            await client.query("COMMIT");
            return { ...recetaFinal, ingredientes: detalles };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
