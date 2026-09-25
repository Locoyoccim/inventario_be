import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    SELECT_ALL: `SELECT * FROM empresas ORDER BY id ASC`,
    SELECT_BY_ID: `SELECT * FROM empresas WHERE id = $1`,
    EXISTS_EMPRESA: `SELECT 1 FROM empresas WHERE id = $1`,
    INSERT: `
        INSERT INTO empresas (nombre, titular, telefono, email, domicilio)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, titular, telefono, email, domicilio
    `,
    UPDATE: `
        UPDATE empresas 
        SET nombre = $1, titular = $2, telefono = $3, email = $4, domicilio = $5 
        WHERE id = $6
        RETURNING id, nombre, titular, telefono, email, domicilio
    `,
    DELETE: `DELETE FROM empresas WHERE id = $1 RETURNING id`,
};

export default class EmpresaRepository {
    async findAll() {
        const result = await pool.query(QUERIES.SELECT_ALL);
        return result.rows;
    }

    async findById(id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
        return result.rows[0];
    }

    async existsEmpresa(id) {
        const result = await pool.query(QUERIES.EXISTS_EMPRESA, [id]);
        return result.rowCount > 0;
    }

    async create({ nombre, titular, telefono, email, domicilio }) {
        if (!nombre) throw ApiError.badRequest("nombre es requerido");

        const values = [nombre, titular ?? null, telefono ?? null, email ?? null, domicilio ?? null];
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(QUERIES.INSERT, values);
            const empresa = result.rows[0];
            // Sembrar las categorías de gasto base para la nueva empresa (FINANZAS).
            await client.query(
                `INSERT INTO categorias_gasto (empresa_id, nombre)
                 SELECT $1, c.nombre FROM (VALUES
                    ('Renta'),('Luz'),('Agua'),('Gas'),('Sueldos'),
                    ('Mantenimiento'),('Publicidad'),('Impuestos y comisiones'),('Otros')
                 ) AS c(nombre)
                 ON CONFLICT (empresa_id, lower(nombre)) DO NOTHING`,
                [empresa.id]
            );
            await client.query("COMMIT");
            return empresa;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async update(id, { nombre, titular, telefono, email, domicilio }) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!nombre) throw ApiError.badRequest("nombre es requerido");

        const values = [nombre, titular ?? null, telefono ?? null, email ?? null, domicilio ?? null, id];
        const result = await pool.query(QUERIES.UPDATE, values);
        return result.rows[0];
    }

    async remove(id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        const result = await pool.query(QUERIES.DELETE, [id]);
        return result.rows[0];
    }

    // Configuración fiscal/comercial de la empresa.
    async getConfig(id) {
        const r = await pool.query(
            "SELECT iva_pct, precios_incluyen_iva, food_cost_objetivo FROM empresas WHERE id = $1",
            [id]
        );
        return r.rows[0];
    }

    // Actualiza la configuración (campos opcionales). Con aplicarARecetas=true, propaga el
    // IVA de la empresa a TODAS sus recetas (por defecto solo aplica a las nuevas).
    async updateConfig(id, { iva_pct, precios_incluyen_iva, food_cost_objetivo }, aplicarARecetas = false) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const upd = await client.query(
                `UPDATE empresas
                 SET iva_pct = COALESCE($2, iva_pct),
                     precios_incluyen_iva = COALESCE($3, precios_incluyen_iva),
                     food_cost_objetivo = COALESCE($4, food_cost_objetivo)
                 WHERE id = $1
                 RETURNING iva_pct, precios_incluyen_iva, food_cost_objetivo`,
                [id, iva_pct ?? null, precios_incluyen_iva ?? null, food_cost_objetivo ?? null]
            );
            const cfg = upd.rows[0];
            let recetas_actualizadas = 0;
            if (cfg && aplicarARecetas) {
                const r = await client.query(
                    "UPDATE recetas SET iva_pct = $2, precio_incluye_iva = $3 WHERE empresa_id = $1",
                    [id, cfg.iva_pct, cfg.precios_incluyen_iva]
                );
                recetas_actualizadas = r.rowCount;
            }
            await client.query("COMMIT");
            return cfg ? { ...cfg, recetas_actualizadas } : null;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
