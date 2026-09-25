import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    LIST_ALL: `SELECT id, empresa_id, nombre, tipo, activo FROM categorias WHERE empresa_id = $1 ORDER BY nombre ASC`,
    // tipo=PRODUCTO -> PRODUCTO + AMBAS; tipo=RECETA -> RECETA + AMBAS.
    LIST_TIPO: `SELECT id, empresa_id, nombre, tipo, activo FROM categorias WHERE empresa_id = $1 AND (tipo = $2 OR tipo = 'AMBAS') ORDER BY nombre ASC`,
    GET: `SELECT id, empresa_id, nombre, tipo, activo FROM categorias WHERE id = $1 AND empresa_id = $2`,
    EXISTS_NOMBRE: `SELECT 1 FROM categorias WHERE empresa_id = $1 AND lower(nombre) = lower($2) AND ($3::int IS NULL OR id <> $3) LIMIT 1`,
    INSERT: `INSERT INTO categorias (empresa_id, nombre, tipo) VALUES ($1, $2, COALESCE($3, 'AMBAS')) RETURNING id, empresa_id, nombre, tipo, activo`,
    DELETE: `DELETE FROM categorias WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    COUNT_USO: `
        SELECT
          (SELECT COUNT(*) FROM productos WHERE empresa_id = $1 AND btrim(categoria) = $2)::int AS productos,
          (SELECT COUNT(*) FROM recetas  WHERE empresa_id = $1 AND btrim(categoria) = $2)::int AS recetas`,
};

export default class CategoriaRepository {
    async findAll(empresa_id, { tipo = null } = {}) {
        if (tipo === "PRODUCTO" || tipo === "RECETA") {
            return (await pool.query(QUERIES.LIST_TIPO, [empresa_id, tipo])).rows;
        }
        return (await pool.query(QUERIES.LIST_ALL, [empresa_id])).rows;
    }

    async #existeNombre(runner, empresa_id, nombre, exceptId = null) {
        const r = await runner.query(QUERIES.EXISTS_NOMBRE, [empresa_id, nombre, exceptId]);
        return r.rowCount > 0;
    }

    async create(empresa_id, { nombre, tipo = null }) {
        // Unicidad case-insensitive (el índice único es el respaldo).
        if (await this.#existeNombre(pool, empresa_id, nombre)) {
            throw ApiError.conflict("Ya existe una categoría con ese nombre");
        }
        return (await pool.query(QUERIES.INSERT, [empresa_id, nombre, tipo])).rows[0];
    }

    // Renombra en cascada (productos + recetas) y/o cambia el tipo, en UNA transacción.
    // Devuelve la categoría + productos_actualizados + recetas_actualizadas.
    async update(empresa_id, id, { nombre, tipo }) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const cur = (await client.query(
                "SELECT id, nombre, tipo FROM categorias WHERE id = $1 AND empresa_id = $2 FOR UPDATE",
                [id, empresa_id]
            )).rows[0];
            if (!cur) { await client.query("ROLLBACK"); return null; }

            const nuevoNombre = nombre ?? cur.nombre;
            const nuevoTipo = tipo ?? cur.tipo;
            const cambiaNombre = nuevoNombre !== cur.nombre;

            if (cambiaNombre && (await this.#existeNombre(client, empresa_id, nuevoNombre, id))) {
                await client.query("ROLLBACK");
                throw ApiError.conflict("Ya existe una categoría con ese nombre");
            }

            const cat = (await client.query(
                "UPDATE categorias SET nombre = $1, tipo = $2 WHERE id = $3 AND empresa_id = $4 RETURNING id, empresa_id, nombre, tipo, activo",
                [nuevoNombre, nuevoTipo, id, empresa_id]
            )).rows[0];

            let productos_actualizados = 0;
            let recetas_actualizadas = 0;
            if (cambiaNombre) {
                productos_actualizados = (await client.query(
                    "UPDATE productos SET categoria = $1 WHERE empresa_id = $2 AND btrim(categoria) = $3",
                    [nuevoNombre, empresa_id, cur.nombre]
                )).rowCount;
                recetas_actualizadas = (await client.query(
                    "UPDATE recetas SET categoria = $1 WHERE empresa_id = $2 AND btrim(categoria) = $3",
                    [nuevoNombre, empresa_id, cur.nombre]
                )).rowCount;
            }

            await client.query("COMMIT");
            return { ...cat, productos_actualizados, recetas_actualizadas };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async contarUso(empresa_id, nombre) {
        return (await pool.query(QUERIES.COUNT_USO, [empresa_id, nombre])).rows[0];
    }

    // Elimina la categoría. Con reasignar_a mueve productos/recetas al destino y luego borra
    // (transacción). Sin reasignar_a: 409 si está en uso; si no, borra.
    async remove(empresa_id, id, reasignar_a = null) {
        const cur = (await pool.query(QUERIES.GET, [id, empresa_id])).rows[0];
        if (!cur) return null;

        if (reasignar_a !== null && reasignar_a !== undefined && `${reasignar_a}` !== "") {
            if (Number(reasignar_a) === Number(id)) {
                throw ApiError.badRequest("reasignar_a no puede ser la misma categoría");
            }
            const dest = (await pool.query(QUERIES.GET, [reasignar_a, empresa_id])).rows[0];
            if (!dest) throw ApiError.badRequest("La categoría destino no existe en la empresa");

            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const productos_movidos = (await client.query(
                    "UPDATE productos SET categoria = $1 WHERE empresa_id = $2 AND btrim(categoria) = $3",
                    [dest.nombre, empresa_id, cur.nombre]
                )).rowCount;
                const recetas_movidas = (await client.query(
                    "UPDATE recetas SET categoria = $1 WHERE empresa_id = $2 AND btrim(categoria) = $3",
                    [dest.nombre, empresa_id, cur.nombre]
                )).rowCount;
                await client.query("DELETE FROM categorias WHERE id = $1 AND empresa_id = $2", [id, empresa_id]);
                await client.query("COMMIT");
                return { id: Number(id), reasignado_a: Number(reasignar_a), productos_movidos, recetas_movidas };
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }

        const uso = await this.contarUso(empresa_id, cur.nombre);
        if (uso.productos + uso.recetas > 0) {
            throw new ApiError(409, "La categoría está en uso; reasigna o quita su uso primero", {
                productos: uso.productos,
                recetas: uso.recetas,
            });
        }
        await pool.query(QUERIES.DELETE, [id, empresa_id]);
        return { id: Number(id) };
    }
}
