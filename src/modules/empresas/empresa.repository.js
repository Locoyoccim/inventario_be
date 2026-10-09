import pool from "../../config/db.js";
import { notificar } from "../../realtime/eventosPos.js";
import { registrarActividad } from "../actividad/actividad.js";

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
            "SELECT iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria, usa_pantalla_cocina FROM empresas WHERE id = $1",
            [id],
        );
        return r.rows[0];
    }

    // Actualiza la configuración (campos opcionales). Con aplicarARecetas=true, propaga el
    // IVA de la empresa a TODAS sus recetas (por defecto solo aplica a las nuevas).
    // `actividad` (contexto de la bitácora) es OBLIGATORIO: la fila de admin_actividad entra en la MISMA transacción, así que si no se puede
    // registrar, la configuración (y el IVA de las recetas, si se propaga) no cambia. Sin él no se abre ni la transacción.
    async updateConfig(id, data, aplicarARecetas = false, actividad = undefined) {
        if (!actividad)
            throw new Error("updateConfig exige el contexto de la bitácora (actividad)");
        const {
            iva_pct,
            precios_incluyen_iva,
            food_cost_objetivo,
            zona_horaria,
            usa_pantalla_cocina,
        } = data;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const upd = await client.query(
                `UPDATE empresas
                 SET iva_pct = COALESCE($2, iva_pct),
                     precios_incluyen_iva = COALESCE($3, precios_incluyen_iva),
                     food_cost_objetivo = COALESCE($4, food_cost_objetivo),
                     zona_horaria = COALESCE($5, zona_horaria),
                     usa_pantalla_cocina = COALESCE($6, usa_pantalla_cocina)
                 WHERE id = $1
                 RETURNING iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria, usa_pantalla_cocina`,
                [
                    id,
                    iva_pct ?? null,
                    precios_incluyen_iva ?? null,
                    food_cost_objetivo ?? null,
                    zona_horaria ?? null,
                    usa_pantalla_cocina ?? null,
                ],
            );
            // Apagar la pantalla no borra nada: lo que seguía abierto en ella se da por entregado para que no estorbe.
            if (usa_pantalla_cocina === false) {
                await client.query(
                    "UPDATE pos_comandas SET estado = 'ENTREGADA', actualizada_at = now() WHERE empresa_id = $1 AND estado IN ('NUEVA','EN_PREPARACION','LISTA')",
                    [id],
                );
                // Un área que solo mostraba pantalla se quedaría sin comanda: vuelve a imprimir (su opción de pantalla se conserva por si se reactiva).
                await client.query(
                    "UPDATE areas_preparacion SET imprime = true WHERE empresa_id = $1 AND pantalla AND NOT imprime",
                    [id],
                );
            }
            if (usa_pantalla_cocina !== undefined)
                await notificar(client, { tipo: "config", empresa_id: id });
            const cfg = upd.rows[0];
            let recetas_actualizadas = 0;
            if (cfg && aplicarARecetas) {
                const r = await client.query(
                    "UPDATE recetas SET iva_pct = $2, precio_incluye_iva = $3 WHERE empresa_id = $1",
                    [id, cfg.iva_pct, cfg.precios_incluyen_iva],
                );
                recetas_actualizadas = r.rowCount;
            }
            if (cfg) {
                await registrarActividad(client, actividad, {
                    empresa_id: id,
                    accion: "empresa.configuracion_actualizar",
                    objeto_tipo: "empresa",
                    objeto_id: id,
                    detalle: {
                        campos: Object.keys(data),
                        aplicar_a_recetas: aplicarARecetas,
                        recetas_actualizadas,
                    },
                });
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
