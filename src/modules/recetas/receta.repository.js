import pool from "../../config/db.js";
import { recalcularCostoTotal } from "../../utils/costeo.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    SELECT_ALL: `
    SELECT id, nombre, categoria, precio_venta, costo_total, margen, activo,
           created_at, empresa_id, costo_produccion, proteccion_pct,
           es_preparacion, rendimiento, producto_elaborado_id,
           COUNT(*) OVER()::int AS total
    FROM recetas
    WHERE empresa_id = $1
    ORDER BY id ASC
    LIMIT $2 OFFSET $3;`,
    SELECT_BY_ID: `
    SELECT id, nombre, categoria, precio_venta, costo_total, margen, activo,
           created_at, empresa_id, costo_produccion, proteccion_pct,
           es_preparacion, rendimiento, producto_elaborado_id
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
    INSERT INTO recetas (nombre, categoria, precio_venta, costo_total, activo, empresa_id, costo_produccion, proteccion_pct, es_preparacion, rendimiento)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *;`,
    // Producto elaborado: proveedor_id NULL, costo reutiliza la columna generada.
    INSERT_PRODUCTO_ELAB: `
    INSERT INTO productos (producto, unidad_medida, proveedor_id, categoria, empresa_id, cantidad_presentacion, costo_presentacion, es_elaborado)
    VALUES ($1, $2, NULL, $3, $4, $5, $6, true)
    RETURNING id, producto, unidad_medida, categoria, cantidad_presentacion, costo_presentacion, costo_unitario, es_elaborado;`,
    INSERT_INVENTARIO_ELAB: `
    INSERT INTO inventario (producto_id, stock_actual, stock_minimo, empresa_id, updated_at)
    VALUES ($1, 0, $2, $3, CURRENT_TIMESTAMP)
    RETURNING stock_actual, stock_minimo;`,
    LINK_PRODUCTO_ELAB: `
    UPDATE recetas SET producto_elaborado_id = $1 WHERE id = $2 RETURNING *;`,
};

export default class RecetaRepository {
    async findAll(empresa_id, { limit = 50, offset = 0, q = null, categoria = null, incluirInactivos = false } = {}) {
        const where = ["empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (!incluirInactivos) where.push("activo = true");
        if (q) { where.push(`nombre ILIKE $${i}`); params.push(`%${q}%`); i++; }
        if (categoria) { where.push(`categoria = $${i}`); params.push(categoria); i++; }
        const sql = `
            SELECT id, nombre, categoria, precio_venta, costo_total, margen, activo,
                   created_at, empresa_id, costo_produccion, proteccion_pct,
                   es_preparacion, rendimiento, producto_elaborado_id,
                   COUNT(*) OVER()::int AS total
            FROM recetas
            WHERE ${where.join(" AND ")}
            ORDER BY id ASC
            LIMIT $${i} OFFSET $${i + 1}`;
        params.push(limit, offset);
        const result = await pool.query(sql, params);
        const total = result.rows[0]?.total ?? 0;
        const rows = result.rows.map(({ total, ...r }) => r);
        return { rows, total };
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
            costo_produccion, proteccion_pct, false, 1,
        ]);
        return result.rows[0];
    }

    // Actualiza el encabezado y recalcula costo_total con la fórmula única.
    // Si data.ingredientes viene, reemplaza el escandallo completo en la MISMA
    // transacción (todo o nada) con los costos vigentes de los insumos.
    async update(empresa_id, id, data) {
        const {
            nombre, categoria, precio_venta, activo = true,
            costo_produccion = 0, proteccion_pct = 0, ingredientes,
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
            let detalles;
            if (Array.isArray(ingredientes)) {
                detalles = await this.#reemplazarEscandallo(client, empresa_id, id, ingredientes);
            }
            const receta = await recalcularCostoTotal(client, id);
            await client.query("COMMIT");
            return detalles ? { ...receta, ingredientes: detalles } : receta;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // Borra el escandallo de la receta y lo vuelve a insertar con los costos vigentes.
    // Se llama dentro de una transacción abierta (client).
    async #reemplazarEscandallo(client, empresa_id, receta_id, ingredientes) {
        if (ingredientes.length === 0) {
            throw ApiError.badRequest("Se requiere al menos un ingrediente en 'ingredientes'");
        }
        const rec = await client.query(
            "SELECT producto_elaborado_id FROM recetas WHERE id = $1 AND empresa_id = $2",
            [receta_id, empresa_id]
        );
        const propioElaborado = Number(rec.rows[0]?.producto_elaborado_id) || null;

        const ids = ingredientes.map((i) => Number(i.producto_id));
        const prodRes = await client.query(
            "SELECT id, producto, unidad_medida, es_elaborado, costo_unitario FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
            [empresa_id, ids]
        );
        const prodMap = new Map(prodRes.rows.map((r) => [Number(r.id), r]));
        for (const ing of ingredientes) {
            const pid = Number(ing.producto_id);
            if (!prodMap.has(pid)) {
                throw ApiError.badRequest(`El producto ${pid} no existe en la empresa ${empresa_id}`);
            }
            if (propioElaborado && pid === propioElaborado) {
                throw ApiError.badRequest("Una preparación no puede llevarse a sí misma como ingrediente");
            }
        }

        await client.query("DELETE FROM receta_detalle WHERE receta_id = $1", [receta_id]);
        const detalles = [];
        for (const ing of ingredientes) {
            const prod = prodMap.get(Number(ing.producto_id));
            const det = await client.query(
                `INSERT INTO receta_detalle (receta_id, producto_id, cantidad, costo_unitario)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, receta_id, producto_id, cantidad, costo_unitario, costo_final`,
                [receta_id, prod.id, ing.cantidad, prod.costo_unitario]
            );
            detalles.push({
                ...det.rows[0],
                producto: prod.producto,
                unidad_medida: prod.unidad_medida,
                es_elaborado: prod.es_elaborado,
            });
        }
        return detalles;
    }

    async remove(empresa_id, id) {
        const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
        return result.rows[0];
    }

    // Crea la receta y todo su escandallo en UNA transacción. Usa la fórmula única.
    // Si data.es_preparacion === true, además crea el producto elaborado + su fila de
    // inventario y enlaza recetas.producto_elaborado_id (Opción A: subrecetas).
    // data: { nombre, categoria, precio_venta, activo?, costo_produccion?, proteccion_pct?,
    //         ingredientes: [{producto_id, cantidad}],
    //         es_preparacion?, rendimiento?, unidad?, stock_minimo? }
    async createConDetalle(empresa_id, data) {
        const {
            nombre, categoria, precio_venta, activo = true,
            costo_produccion = 0, proteccion_pct = 0, ingredientes = [],
            es_preparacion = false, rendimiento = 1, unidad = null, stock_minimo = 0,
        } = data;
        if (!Array.isArray(ingredientes) || ingredientes.length === 0) {
            throw ApiError.badRequest("Se requiere al menos un ingrediente en 'ingredientes'");
        }
        if (es_preparacion && (rendimiento == null || Number(rendimiento) <= 0 || !unidad)) {
            throw ApiError.badRequest("Una preparación requiere 'rendimiento' > 0 y 'unidad'");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const recRes = await client.query(QUERIES.INSERT, [
                nombre, categoria, precio_venta, 0, activo, empresa_id,
                costo_produccion, proteccion_pct, es_preparacion, es_preparacion ? rendimiento : 1,
            ]);
            const receta = recRes.rows[0];

            // Un solo query para todos los insumos (evita N+1)
            const ids = ingredientes.map((i) => Number(i.producto_id));
            const prodRes = await client.query(
                "SELECT id, producto, costo_unitario FROM productos WHERE empresa_id = $1 AND id = ANY($2)",
                [empresa_id, ids]
            );
            const prodMap = new Map(prodRes.rows.map((r) => [Number(r.id), r]));

            const detalles = [];
            for (const ing of ingredientes) {
                const { producto_id, cantidad } = ing;
                if (!producto_id || cantidad === undefined || cantidad === null) {
                    throw ApiError.badRequest("Cada ingrediente requiere 'producto_id' y 'cantidad'");
                }
                const prod = prodMap.get(Number(producto_id));
                if (!prod) {
                    throw ApiError.badRequest(`El producto ${producto_id} no existe en la empresa ${empresa_id}`);
                }
                const det = await client.query(
                    `INSERT INTO receta_detalle (receta_id, producto_id, cantidad, costo_unitario)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id, receta_id, producto_id, cantidad, costo_unitario, costo_final`,
                    [receta.id, producto_id, cantidad, prod.costo_unitario]
                );
                detalles.push({ ...det.rows[0], producto: prod.producto });
            }

            let recetaFinal = await recalcularCostoTotal(client, receta.id);

            // Alta del producto elaborado (subreceta) y enlace
            let productoElaborado = null;
            if (es_preparacion) {
                const prodElab = await client.query(QUERIES.INSERT_PRODUCTO_ELAB, [
                    nombre,
                    unidad,
                    "Preparación",
                    empresa_id,
                    rendimiento,                    // cantidad_presentacion = rendimiento
                    Number(recetaFinal.costo_total), // costo_presentacion = costo_total
                ]);
                productoElaborado = prodElab.rows[0];

                // Asegura que la categoría "Preparación" (tipo PRODUCTO) exista en la lista compartida.
                await client.query(
                    `INSERT INTO categorias (empresa_id, nombre, tipo)
                     SELECT $1, 'Preparación', 'PRODUCTO'
                     WHERE NOT EXISTS (SELECT 1 FROM categorias WHERE empresa_id = $1 AND lower(nombre) = lower('Preparación'))`,
                    [empresa_id]
                );

                const inv = await client.query(QUERIES.INSERT_INVENTARIO_ELAB, [
                    productoElaborado.id,
                    stock_minimo,
                    empresa_id,
                ]);
                productoElaborado = { ...productoElaborado, ...inv.rows[0] };

                const linked = await client.query(QUERIES.LINK_PRODUCTO_ELAB, [
                    productoElaborado.id,
                    receta.id,
                ]);
                recetaFinal = linked.rows[0];
            }

            await client.query("COMMIT");
            return { ...recetaFinal, ingredientes: detalles, producto_elaborado: productoElaborado };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
