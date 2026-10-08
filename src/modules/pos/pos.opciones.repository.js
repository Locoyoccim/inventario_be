// Catálogo de opciones por producto: grupos, opciones y a qué artículos se ofrecen. Y la resolución de lo que elige el mesero.
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { validarSeleccion } from "./pos.opciones.logic.js";

const GRUPOS_DE_ARTICULO = `
    SELECT g.id, g.nombre, g.minimo, g.maximo
    FROM articulo_modificadores am JOIN modificador_grupos g ON g.id = am.grupo_id
    WHERE g.empresa_id = $1 AND g.activo AND ((am.receta_id = $2 AND $3 = 'RECETA') OR (am.producto_id = $2 AND $3 = 'PRODUCTO'))
    ORDER BY g.id`;

const MODIFICADORES = `
    SELECT m.id, m.grupo_id, m.nombre, m.precio_extra, m.producto_id, m.cantidad, m.orden
    FROM modificadores m WHERE m.grupo_id = ANY($1::int[]) AND m.activo ORDER BY m.orden, m.id`;

export default class PosOpcionesRepository {
    // ---- Resolución al tomar la orden ----

    /** Grupos activos asignados a un artículo, con sus opciones activas. */
    async gruposDeArticulo(db, empresa_id, tipo, articulo_id) {
        const grupos = (await db.query(GRUPOS_DE_ARTICULO, [empresa_id, articulo_id, tipo])).rows;
        if (grupos.length === 0) return [];
        const mods = (await db.query(MODIFICADORES, [grupos.map((g) => g.id)])).rows;
        return grupos.map((g) => ({ ...g, modificadores: mods.filter((m) => m.grupo_id === g.id) }));
    }

    /** Valida lo elegido y devuelve el snapshot y el extra por pieza. Sin grupos asignados, no admite opciones. */
    async resolver(db, empresa_id, tipo, articulo_id, ids) {
        const grupos = await this.gruposDeArticulo(db, empresa_id, tipo, articulo_id);
        return validarSeleccion(grupos, ids);
    }

    // ---- Catálogo (Admin) ----

    async listar(empresa_id) {
        const grupos = (await pool.query("SELECT id, nombre, minimo, maximo, activo FROM modificador_grupos WHERE empresa_id = $1 AND activo ORDER BY nombre", [empresa_id])).rows;
        if (grupos.length === 0) return { grupos: [] };
        const ids = grupos.map((g) => g.id);
        const [mods, arts] = await Promise.all([
            pool.query(
                `SELECT m.id, m.grupo_id, m.nombre, m.precio_extra, m.producto_id, p.producto, m.cantidad, m.orden
                 FROM modificadores m LEFT JOIN productos p ON p.id = m.producto_id
                 WHERE m.grupo_id = ANY($1::int[]) AND m.activo ORDER BY m.orden, m.id`,
                [ids],
            ),
            pool.query("SELECT grupo_id, receta_id, producto_id FROM articulo_modificadores WHERE grupo_id = ANY($1::int[])", [ids]),
        ]);
        return {
            grupos: grupos.map((g) => ({
                ...g,
                modificadores: mods.rows.filter((m) => m.grupo_id === g.id).map((m) => ({ ...m, precio_extra: Number(m.precio_extra), cantidad: m.cantidad === null ? null : Number(m.cantidad) })),
                articulos: arts.rows.filter((a) => a.grupo_id === g.id).map((a) => (a.receta_id ? { tipo: "RECETA", id: a.receta_id } : { tipo: "PRODUCTO", id: a.producto_id })),
            })),
        };
    }

    async #validarDatos(client, empresa_id, { nombre, minimo, maximo, modificadores, articulos }, grupoId = null) {
        const dup = await client.query("SELECT 1 FROM modificador_grupos WHERE empresa_id = $1 AND activo AND lower(nombre) = lower($2) AND ($3::int IS NULL OR id <> $3)", [empresa_id, nombre, grupoId]);
        if (dup.rowCount > 0) throw ApiError.conflict("Ya existe un grupo de opciones con ese nombre");
        if (minimo > maximo) throw ApiError.badRequest("El mínimo no puede ser mayor al máximo");
        if (modificadores.length === 0) throw ApiError.badRequest("Agrega al menos una opción");
        if (maximo > modificadores.length) throw ApiError.badRequest("El máximo no puede ser mayor al número de opciones");
        const nombres = modificadores.map((m) => m.nombre.trim().toLowerCase());
        if (new Set(nombres).size !== nombres.length) throw ApiError.badRequest("Hay opciones repetidas en el grupo");
        const insumos = [...new Set(modificadores.map((m) => m.producto_id).filter(Boolean))];
        if (insumos.length) {
            const r = await client.query("SELECT id FROM productos WHERE empresa_id = $1 AND id = ANY($2::int[])", [empresa_id, insumos]);
            if (r.rowCount !== insumos.length) throw ApiError.badRequest("Un insumo de las opciones no existe en la empresa");
        }
        const recetas = articulos.filter((a) => a.tipo === "RECETA").map((a) => a.id);
        const productos = articulos.filter((a) => a.tipo === "PRODUCTO").map((a) => a.id);
        if (recetas.length && (await client.query("SELECT 1 FROM recetas WHERE empresa_id = $1 AND id = ANY($2::int[])", [empresa_id, recetas])).rowCount !== recetas.length) throw ApiError.badRequest("Una receta no existe en la empresa");
        if (productos.length && (await client.query("SELECT 1 FROM productos WHERE empresa_id = $1 AND id = ANY($2::int[])", [empresa_id, productos])).rowCount !== productos.length) throw ApiError.badRequest("Un producto no existe en la empresa");
    }

    async #guardarHijos(client, grupo_id, { modificadores, articulos }) {
        // Las opciones que ya no vienen se desactivan (no se borran): las cuentas ya tomadas guardan su copia, pero el historial sigue legible.
        const conservar = modificadores.filter((m) => m.id).map((m) => m.id);
        await client.query("UPDATE modificadores SET activo = false WHERE grupo_id = $1 AND NOT (id = ANY($2::int[]))", [grupo_id, conservar]);
        let orden = 0;
        for (const m of modificadores) {
            const valores = [m.nombre.trim(), m.precio_extra ?? 0, m.producto_id ?? null, m.producto_id ? m.cantidad : null, orden++];
            if (m.id) {
                const r = await client.query(
                    "UPDATE modificadores SET nombre = $3, precio_extra = $4, producto_id = $5, cantidad = $6, orden = $7, activo = true WHERE id = $1 AND grupo_id = $2",
                    [m.id, grupo_id, ...valores],
                );
                if (r.rowCount === 0) throw ApiError.badRequest("Una opción no pertenece a este grupo");
            } else {
                await client.query("INSERT INTO modificadores (grupo_id, nombre, precio_extra, producto_id, cantidad, orden) VALUES ($1,$2,$3,$4,$5,$6)", [grupo_id, ...valores]);
            }
        }
        await client.query("DELETE FROM articulo_modificadores WHERE grupo_id = $1", [grupo_id]);
        for (const a of articulos) {
            await client.query(
                "INSERT INTO articulo_modificadores (grupo_id, receta_id, producto_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                [grupo_id, a.tipo === "RECETA" ? a.id : null, a.tipo === "PRODUCTO" ? a.id : null],
            );
        }
    }

    async #tx(fn) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const r = await fn(client);
            await client.query("COMMIT");
            return r;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async crear(empresa_id, datos) {
        const id = await this.#tx(async (client) => {
            await this.#validarDatos(client, empresa_id, datos);
            const r = await client.query("INSERT INTO modificador_grupos (empresa_id, nombre, minimo, maximo) VALUES ($1,$2,$3,$4) RETURNING id", [empresa_id, datos.nombre, datos.minimo, datos.maximo]);
            await this.#guardarHijos(client, r.rows[0].id, datos);
            return r.rows[0].id;
        });
        return (await this.listar(empresa_id)).grupos.find((g) => g.id === id);
    }

    async actualizar(empresa_id, id, datos) {
        id = Number(id);
        await this.#tx(async (client) => {
            const existe = await client.query("SELECT 1 FROM modificador_grupos WHERE id = $1 AND empresa_id = $2 AND activo FOR UPDATE", [id, empresa_id]);
            if (existe.rowCount === 0) throw ApiError.notFound("Grupo de opciones no encontrado");
            await this.#validarDatos(client, empresa_id, datos, id);
            await client.query("UPDATE modificador_grupos SET nombre = $3, minimo = $4, maximo = $5 WHERE id = $1 AND empresa_id = $2", [id, empresa_id, datos.nombre, datos.minimo, datos.maximo]);
            await this.#guardarHijos(client, id, datos);
        });
        return (await this.listar(empresa_id)).grupos.find((g) => g.id === id);
    }

    // No se borra: las cuentas ya tomadas conservan su copia. Deja de ofrecerse y libera el nombre.
    async desactivar(empresa_id, id) {
        id = Number(id);
        const r = await pool.query("UPDATE modificador_grupos SET activo = false WHERE id = $1 AND empresa_id = $2 AND activo RETURNING id", [id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.notFound("Grupo de opciones no encontrado");
        return { id, activo: false };
    }
}
