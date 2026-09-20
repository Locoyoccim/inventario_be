import pool from "../../config/db.js";
import { normalizar } from "../../utils/normalize.js";

const TIPOS_VALIDOS = ["RECETA", "INSUMO", "IGNORAR"];

const QUERIES = {
    SELECT_ALL: `
        SELECT id, empresa_id, nombre_pos, tipo, receta_id, producto_id, factor, created_at
        FROM pos_map
        WHERE empresa_id = $1
        ORDER BY nombre_pos ASC
    `,
    SELECT_BY_ID: `
        SELECT id, empresa_id, nombre_pos, tipo, receta_id, producto_id, factor, created_at
        FROM pos_map
        WHERE id = $1 AND empresa_id = $2
    `,
    // Upsert por (empresa_id, nombre_pos): si el nombre ya existe, actualiza el mapeo.
    UPSERT: `
        INSERT INTO pos_map (empresa_id, nombre_pos, tipo, receta_id, producto_id, factor)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (empresa_id, nombre_pos) DO UPDATE
        SET tipo = EXCLUDED.tipo,
            receta_id = EXCLUDED.receta_id,
            producto_id = EXCLUDED.producto_id,
            factor = EXCLUDED.factor
        RETURNING id, empresa_id, nombre_pos, tipo, receta_id, producto_id, factor, created_at
    `,
    UPDATE_BY_ID: `
        UPDATE pos_map
        SET nombre_pos = $1, tipo = $2, receta_id = $3, producto_id = $4, factor = $5
        WHERE id = $6 AND empresa_id = $7
        RETURNING id, empresa_id, nombre_pos, tipo, receta_id, producto_id, factor, created_at
    `,
    DELETE: `DELETE FROM pos_map WHERE id = $1 AND empresa_id = $2 RETURNING id`,
};

// Deja el registro coherente con la restricción de la BD y normaliza el nombre.
function prepararFila(empresa_id, data) {
    const nombre_pos = normalizar(data.nombre_pos);
    const tipo = String(data.tipo ?? "").toUpperCase().trim();
    const factor = data.factor === undefined || data.factor === null ? 1 : Number(data.factor);

    if (!nombre_pos) throw new Error("nombre_pos es requerido");
    if (!TIPOS_VALIDOS.includes(tipo)) {
        throw new Error(`tipo debe ser uno de: ${TIPOS_VALIDOS.join(", ")}`);
    }
    if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error("factor debe ser un número mayor a 0");
    }

    let receta_id = null;
    let producto_id = null;
    if (tipo === "RECETA") {
        if (!data.receta_id) throw new Error("receta_id es requerido cuando tipo = RECETA");
        receta_id = Number(data.receta_id);
    } else if (tipo === "INSUMO") {
        if (!data.producto_id) throw new Error("producto_id es requerido cuando tipo = INSUMO");
        producto_id = Number(data.producto_id);
    }
    // IGNORAR: ambas referencias quedan en null.

    return { empresa_id, nombre_pos, tipo, receta_id, producto_id, factor };
}

export default class PosMapRepository {
    async findAll(empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
        return result.rows;
    }

    async findById(id, empresa_id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id, empresa_id]);
        return result.rows[0];
    }

    async upsert(empresa_id, data) {
        const f = prepararFila(empresa_id, data);
        const result = await pool.query(QUERIES.UPSERT, [
            f.empresa_id, f.nombre_pos, f.tipo, f.receta_id, f.producto_id, f.factor,
        ]);
        return result.rows[0];
    }

    // Carga masiva del mapeo en una sola transacción.
    async upsertBulk(empresa_id, filas) {
        if (!Array.isArray(filas) || filas.length === 0) {
            throw new Error("Se espera un arreglo de mapeos no vacío");
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const resultados = [];
            for (const fila of filas) {
                const f = prepararFila(empresa_id, fila);
                const r = await client.query(QUERIES.UPSERT, [
                    f.empresa_id, f.nombre_pos, f.tipo, f.receta_id, f.producto_id, f.factor,
                ]);
                resultados.push(r.rows[0]);
            }
            await client.query("COMMIT");
            return resultados;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async update(id, empresa_id, data) {
        const f = prepararFila(empresa_id, data);
        const result = await pool.query(QUERIES.UPDATE_BY_ID, [
            f.nombre_pos, f.tipo, f.receta_id, f.producto_id, f.factor, id, empresa_id,
        ]);
        return result.rows[0];
    }

    async remove(id, empresa_id) {
        const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
        return result.rows[0];
    }
}
