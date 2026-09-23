import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { normalizarLotes, validarPreparacion, cantidadProducida, cantidadInsumo, calcularSugerencia } from "./produccion.logic.js";

const QUERIES = {
    // Preparaciones (productos elaborados) con su receta e inventario
    SELECT_ELABORADOS: `
        SELECT r.id AS receta_id, r.nombre, r.rendimiento, r.producto_elaborado_id,
               p.producto, p.unidad_medida, p.costo_unitario,
               i.stock_actual, i.stock_minimo
        FROM recetas r
        JOIN productos p  ON p.id = r.producto_elaborado_id
        JOIN inventario i ON i.producto_id = p.id
        WHERE r.empresa_id = $1 AND r.es_preparacion = true
        ORDER BY r.nombre ASC;`,
    // Escandallo de varias recetas de una vez (evita N+1)
    SELECT_DETALLE_LOTE: `
        SELECT rd.receta_id, rd.producto_id, rd.cantidad, rd.costo_unitario,
               pr.producto, pr.unidad_medida
        FROM receta_detalle rd
        JOIN productos pr ON pr.id = rd.producto_id
        WHERE rd.receta_id = ANY($1);`,
    SELECT_RECETA_PREP: `
        SELECT id, nombre, es_preparacion, rendimiento, producto_elaborado_id
        FROM recetas WHERE id = $1 AND empresa_id = $2;`,
    SELECT_DETALLE_RECETA: `
        SELECT producto_id, cantidad FROM receta_detalle WHERE receta_id = $1;`,
    SELECT_PRODUCTO_ELAB: `
        SELECT producto, unidad_medida FROM productos WHERE id = $1;`,
};

export default class ProduccionRepository {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    // Sugerencias de producción: preparaciones cuyo stock cayó por debajo del mínimo.
    // Propone lotes enteros hasta reponer al menos el mínimo, y lista los insumos que
    // consumiría cada lote sugerido.
    async sugerencias(empresa_id) {
        const elab = await pool.query(QUERIES.SELECT_ELABORADOS, [empresa_id]);
        const candidatos = elab.rows.filter(
            (r) => Number(r.stock_actual) < Number(r.stock_minimo)
        );
        if (candidatos.length === 0) return [];

        const recetaIds = candidatos.map((r) => Number(r.receta_id));
        const det = await pool.query(QUERIES.SELECT_DETALLE_LOTE, [recetaIds]);
        const detalleByReceta = new Map();
        for (const d of det.rows) {
            const key = Number(d.receta_id);
            if (!detalleByReceta.has(key)) detalleByReceta.set(key, []);
            detalleByReceta.get(key).push(d);
        }

        return candidatos.map((r) => {
            const { rendimiento, faltante, lotes, cantidad_a_producir } =
                calcularSugerencia(r.stock_actual, r.stock_minimo, r.rendimiento);
            const insumos = (detalleByReceta.get(Number(r.receta_id)) || []).map((d) => ({
                producto_id: d.producto_id,
                producto: d.producto,
                unidad_medida: d.unidad_medida,
                cantidad_por_lote: Number(d.cantidad),
                cantidad_requerida: cantidadInsumo(d.cantidad, lotes),
            }));
            return {
                receta_id: r.receta_id,
                producto_elaborado_id: r.producto_elaborado_id,
                nombre: r.nombre,
                unidad: r.unidad_medida,
                rendimiento,
                stock_actual: Number(r.stock_actual),
                stock_minimo: Number(r.stock_minimo),
                faltante,
                lotes_sugeridos: lotes,
                cantidad_a_producir,
                insumos_requeridos: insumos,
            };
        });
    }

    // Confirma una o varias producciones en UNA transacción.
    // producciones: [{ receta_id, lotes }]. Consume insumos (PRODUCCION -) y recibe el
    // producto elaborado (PRODUCCION +). Falla completo si algún insumo no alcanza.
    async confirmar(empresa_id, producciones, usuario_id = null) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const resultados = [];

            for (const { receta_id, lotes } of producciones) {
                const nLotes = normalizarLotes(lotes, receta_id);

                const recRes = await client.query(QUERIES.SELECT_RECETA_PREP, [receta_id, empresa_id]);
                const receta = recRes.rows[0];
                if (!receta) throw ApiError.notFound(`Receta ${receta_id} no encontrada`);
                validarPreparacion(receta, receta_id);

                const cantProducida = cantidadProducida(receta.rendimiento, nLotes);

                // 1) Consumir insumos del escandallo (PRODUCCION -, estricto: no permite negativo)
                const detRes = await client.query(QUERIES.SELECT_DETALLE_RECETA, [receta_id]);
                const insumosConsumidos = [];
                for (const d of detRes.rows) {
                    const cantidad = cantidadInsumo(d.cantidad, nLotes);
                    const mov = await this.movimientoRepository.aplicar(
                        client,
                        d.producto_id,
                        empresa_id,
                        {
                            tipo_movimiento: "PRODUCCION",
                            cantidad,
                            usuario_id,
                            motivo: `Producción de ${receta.nombre} (${nLotes} lote/s)`,
                            referencia_tipo: "PRODUCCION",
                            referencia_id: receta_id,
                        }
                    );
                    if (!mov) throw ApiError.notFound(`Insumo ${d.producto_id} sin inventario`);
                    insumosConsumidos.push({
                        producto_id: d.producto_id,
                        cantidad,
                        stock_nuevo: Number(mov.stock_nuevo),
                    });
                }

                // 2) Recibir el producto elaborado (PRODUCCION +, dirección forzada)
                const recepcion = await this.movimientoRepository.aplicar(
                    client,
                    receta.producto_elaborado_id,
                    empresa_id,
                    {
                        tipo_movimiento: "PRODUCCION",
                        cantidad: cantProducida,
                        usuario_id,
                        motivo: `Producción de ${receta.nombre} (${nLotes} lote/s)`,
                        referencia_tipo: "PRODUCCION",
                        referencia_id: receta_id,
                    },
                    { direccion: 1 }
                );
                if (!recepcion) throw ApiError.notFound(`Producto elaborado ${receta.producto_elaborado_id} sin inventario`);

                const infoProd = await client.query(QUERIES.SELECT_PRODUCTO_ELAB, [receta.producto_elaborado_id]);
                resultados.push({
                    receta_id,
                    nombre: receta.nombre,
                    producto_elaborado_id: receta.producto_elaborado_id,
                    unidad: infoProd.rows[0]?.unidad_medida ?? null,
                    lotes: nLotes,
                    cantidad_producida: cantProducida,
                    stock_elaborado_nuevo: Number(recepcion.stock_nuevo),
                    insumos_consumidos: insumosConsumidos,
                });
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
}
