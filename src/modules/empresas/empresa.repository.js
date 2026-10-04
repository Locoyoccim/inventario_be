import pool from "../../config/db.js";

const QUERIES = {
    SELECT_BY_ID: `SELECT * FROM empresas WHERE id = $1`,
    EXISTS_EMPRESA: `SELECT 1 FROM empresas WHERE id = $1`,
};

export default class EmpresaRepository {
    async findById(id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
        return result.rows[0];
    }

    async existsEmpresa(id) {
        const result = await pool.query(QUERIES.EXISTS_EMPRESA, [id]);
        return result.rowCount > 0;
    }

    // Configuración fiscal/comercial de la empresa.
    async getConfig(id) {
        const r = await pool.query(
            "SELECT iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria FROM empresas WHERE id = $1",
            [id]
        );
        return r.rows[0];
    }

    // Actualiza la configuración (campos opcionales). Con aplicarARecetas=true, propaga el
    // IVA de la empresa a TODAS sus recetas (por defecto solo aplica a las nuevas).
    async updateConfig(id, { iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria }, aplicarARecetas = false) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const upd = await client.query(
                `UPDATE empresas
                 SET iva_pct = COALESCE($2, iva_pct),
                     precios_incluyen_iva = COALESCE($3, precios_incluyen_iva),
                     food_cost_objetivo = COALESCE($4, food_cost_objetivo),
                     zona_horaria = COALESCE($5, zona_horaria)
                 WHERE id = $1
                 RETURNING iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria`,
                [id, iva_pct ?? null, precios_incluyen_iva ?? null, food_cost_objetivo ?? null, zona_horaria ?? null]
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
