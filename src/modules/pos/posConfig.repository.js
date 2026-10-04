import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { asegurarAreas } from "./pos.areas.js";

const AREA_COLS = "id, empresa_id, nombre, imprime, es_default, activo";
const MESA_COLS = "id, empresa_id, nombre, zona, capacidad, orden, activo";

const QUERIES = {
    LIST_AREAS: `SELECT ${AREA_COLS} FROM areas_preparacion WHERE empresa_id = $1 ORDER BY es_default DESC, nombre ASC`,
    GET_AREA: `SELECT ${AREA_COLS} FROM areas_preparacion WHERE id = $1 AND empresa_id = $2`,
    EXISTS_AREA_NOMBRE: `SELECT 1 FROM areas_preparacion WHERE empresa_id = $1 AND lower(nombre) = lower($2) AND ($3::int IS NULL OR id <> $3)`,
    UNSET_DEFAULT: `UPDATE areas_preparacion SET es_default = false WHERE empresa_id = $1 AND es_default`,

    LIST_MESAS: `SELECT ${MESA_COLS} FROM mesas WHERE empresa_id = $1 AND ($2::boolean OR activo) ORDER BY orden ASC, nombre ASC`,
    EXISTS_MESA_NOMBRE: `SELECT 1 FROM mesas WHERE empresa_id = $1 AND lower(nombre) = lower($2) AND ($3::int IS NULL OR id <> $3)`,

    CATEGORIAS_AREA: `SELECT id, nombre, tipo, area_id FROM categorias WHERE empresa_id = $1 AND activo ORDER BY nombre ASC`,

    // Artículos vendibles con su área resuelta: propio -> categoría -> default de la empresa.
    // Solo cuentan áreas activas; las preparaciones y los elaborados no se venden directo.
    MENU: `
        WITH def AS (
            SELECT id FROM areas_preparacion WHERE empresa_id = $1 AND es_default AND activo LIMIT 1
        ), articulos AS (
            SELECT 'RECETA' AS tipo, r.id, r.nombre, NULLIF(btrim(r.categoria), '') AS categoria, r.precio_venta,
                   r.iva_pct, r.precio_incluye_iva, r.area_id AS area_propia, c.area_id AS area_categoria
            FROM recetas r
            LEFT JOIN categorias c ON c.empresa_id = r.empresa_id AND c.nombre = btrim(r.categoria)
            WHERE r.empresa_id = $1 AND r.activo AND NOT r.es_preparacion AND r.precio_venta > 0
            UNION ALL
            SELECT 'PRODUCTO', p.id, p.producto, NULLIF(btrim(p.categoria), ''), p.precio_venta,
                   e.iva_pct, e.precios_incluyen_iva, p.area_id, c.area_id
            FROM productos p
            JOIN empresas e ON e.id = p.empresa_id
            LEFT JOIN categorias c ON c.empresa_id = p.empresa_id AND c.nombre = btrim(p.categoria)
            WHERE p.empresa_id = $1 AND p.activo AND NOT p.es_elaborado AND p.precio_venta > 0
        )
        SELECT a.tipo, a.id, a.nombre, a.categoria, a.precio_venta, a.iva_pct, a.precio_incluye_iva, a.area_propia,
               COALESCE(ap.id, ac.id, (SELECT id FROM def)) AS area_id,
               CASE WHEN ap.id IS NOT NULL THEN 'ARTICULO' WHEN ac.id IS NOT NULL THEN 'CATEGORIA' ELSE 'DEFAULT' END AS area_origen
        FROM articulos a
        LEFT JOIN areas_preparacion ap ON ap.id = a.area_propia AND ap.activo
        LEFT JOIN areas_preparacion ac ON ac.id = a.area_categoria AND ac.activo
        ORDER BY a.categoria ASC NULLS LAST, a.nombre ASC`,
    RECETAS_SIN_PRECIO: `SELECT COUNT(*)::int AS n FROM recetas WHERE empresa_id = $1 AND activo AND NOT es_preparacion AND precio_venta <= 0`,
};

const TABLA_ARTICULO = { RECETA: "recetas", PRODUCTO: "productos" };

export default class PosConfigRepository {
    async listarAreas(empresa_id) {
        await asegurarAreas(pool, empresa_id);
        return (await pool.query(QUERIES.LIST_AREAS, [empresa_id])).rows;
    }

    async #validarNombreArea(db, empresa_id, nombre, exceptId = null) {
        const r = await db.query(QUERIES.EXISTS_AREA_NOMBRE, [empresa_id, nombre, exceptId]);
        if (r.rowCount > 0) throw ApiError.conflict("Ya existe un área con ese nombre");
    }

    async crearArea(empresa_id, { nombre, imprime = true, es_default = false }) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await this.#validarNombreArea(client, empresa_id, nombre);
            if (es_default) await client.query(QUERIES.UNSET_DEFAULT, [empresa_id]);
            const r = await client.query(
                `INSERT INTO areas_preparacion (empresa_id, nombre, imprime, es_default) VALUES ($1, $2, $3, $4) RETURNING ${AREA_COLS}`,
                [empresa_id, nombre, imprime, es_default],
            );
            await client.query("COMMIT");
            return r.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async actualizarArea(empresa_id, id, { nombre, imprime, es_default, activo }) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const actual = (await client.query(`${QUERIES.GET_AREA} FOR UPDATE`, [id, empresa_id])).rows[0];
            if (!actual) throw ApiError.notFound("Área no encontrada");
            if (nombre !== undefined) await this.#validarNombreArea(client, empresa_id, nombre, id);
            const quedaDefault = es_default === true || actual.es_default;
            const quedaActiva = activo ?? actual.activo;
            if (quedaDefault && !quedaActiva) throw ApiError.badRequest("El área por defecto no puede desactivarse; elige otra como predeterminada primero");
            if (es_default === true && !actual.es_default) await client.query(QUERIES.UNSET_DEFAULT, [empresa_id]);
            const r = await client.query(
                `UPDATE areas_preparacion
                 SET nombre = COALESCE($3, nombre), imprime = COALESCE($4, imprime),
                     es_default = COALESCE($5, es_default), activo = COALESCE($6, activo)
                 WHERE id = $1 AND empresa_id = $2 RETURNING ${AREA_COLS}`,
                [id, empresa_id, nombre ?? null, imprime ?? null, es_default ?? null, activo ?? null],
            );
            await client.query("COMMIT");
            return r.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async listarMesas(empresa_id, incluirInactivas = false) {
        return (await pool.query(QUERIES.LIST_MESAS, [empresa_id, incluirInactivas])).rows;
    }

    async #validarNombreMesa(empresa_id, nombre, exceptId = null) {
        const r = await pool.query(QUERIES.EXISTS_MESA_NOMBRE, [empresa_id, nombre, exceptId]);
        if (r.rowCount > 0) throw ApiError.conflict("Ya existe una mesa con ese nombre");
    }

    async crearMesa(empresa_id, { nombre, zona = null, capacidad = 4, orden = 0 }) {
        await this.#validarNombreMesa(empresa_id, nombre);
        const r = await pool.query(
            `INSERT INTO mesas (empresa_id, nombre, zona, capacidad, orden) VALUES ($1, $2, $3, $4, $5) RETURNING ${MESA_COLS}`,
            [empresa_id, nombre, zona || null, capacidad, orden],
        );
        return r.rows[0];
    }

    async actualizarMesa(empresa_id, id, { nombre, zona, capacidad, orden, activo }) {
        if (nombre !== undefined) await this.#validarNombreMesa(empresa_id, nombre, id);
        const r = await pool.query(
            `UPDATE mesas
             SET nombre = COALESCE($3, nombre), zona = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE zona END,
                 capacidad = COALESCE($6, capacidad), orden = COALESCE($7, orden), activo = COALESCE($8, activo)
             WHERE id = $1 AND empresa_id = $2 RETURNING ${MESA_COLS}`,
            [id, empresa_id, nombre ?? null, zona !== undefined, zona ?? null, capacidad ?? null, orden ?? null, activo ?? null],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Mesa no encontrada");
        return r.rows[0];
    }

    // Una mesa que nunca tuvo cuentas se borra; con historial de ventas solo se desactiva (las cuentas
    // pasadas la conservan por nombre y los cortes no cambian). Con una cuenta abierta no se toca.
    async eliminarMesa(empresa_id, id) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const mesa = (await client.query("SELECT id, nombre FROM mesas WHERE id = $1 AND empresa_id = $2 FOR UPDATE", [id, empresa_id])).rows[0];
            if (!mesa) throw ApiError.notFound("Mesa no encontrada");
            const abierta = (await client.query("SELECT folio FROM pos_cuentas WHERE mesa_id = $1 AND estado = 'ABIERTA' LIMIT 1", [id])).rows[0];
            if (abierta) throw ApiError.conflict(`${mesa.nombre} tiene una cuenta abierta (folio ${abierta.folio}). Cóbrala o cancélala primero.`);
            const usos = (await client.query("SELECT COUNT(*)::int AS n FROM pos_cuentas WHERE mesa_id = $1", [id])).rows[0].n;
            let accion;
            if (usos === 0) {
                await client.query("DELETE FROM mesas WHERE id = $1", [id]);
                accion = "eliminada";
            } else {
                await client.query("UPDATE mesas SET activo = false WHERE id = $1", [id]);
                accion = "desactivada";
            }
            await client.query("COMMIT");
            return { id: mesa.id, nombre: mesa.nombre, accion };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async #validarArea(empresa_id, area_id) {
        if (area_id == null) return;
        const r = await pool.query(QUERIES.GET_AREA, [area_id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.badRequest("El área no existe en la empresa");
    }

    async listarAsignacion(empresa_id) {
        return (await pool.query(QUERIES.CATEGORIAS_AREA, [empresa_id])).rows;
    }

    async asignarAreaCategoria(empresa_id, id, area_id) {
        await this.#validarArea(empresa_id, area_id);
        const r = await pool.query(
            "UPDATE categorias SET area_id = $3 WHERE id = $1 AND empresa_id = $2 RETURNING id, nombre, tipo, area_id",
            [id, empresa_id, area_id],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Categoría no encontrada");
        return r.rows[0];
    }

    async asignarAreaArticulo(empresa_id, tipo, id, area_id) {
        const tabla = TABLA_ARTICULO[tipo];
        if (!tabla) throw ApiError.badRequest("tipo debe ser RECETA o PRODUCTO");
        await this.#validarArea(empresa_id, area_id);
        const r = await pool.query(`UPDATE ${tabla} SET area_id = $3 WHERE id = $1 AND empresa_id = $2 RETURNING id, area_id`, [id, empresa_id, area_id]);
        if (r.rowCount === 0) throw ApiError.notFound("Artículo no encontrado");
        return { tipo, ...r.rows[0] };
    }

    // Artículos vendibles con área, precio e IVA resueltos. Acepta un client de transacción.
    async articulosVendibles(db, empresa_id) {
        return (await db.query(QUERIES.MENU, [empresa_id])).rows;
    }

    async menu(empresa_id) {
        await this.listarAreas(empresa_id);
        const [articulos, sinPrecio] = await Promise.all([
            this.articulosVendibles(pool, empresa_id),
            pool.query(QUERIES.RECETAS_SIN_PRECIO, [empresa_id]),
        ]);
        return { articulos, recetas_sin_precio: sinPrecio.rows[0].n };
    }
}
