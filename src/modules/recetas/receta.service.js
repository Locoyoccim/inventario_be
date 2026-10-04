import { calcularPreview, enriquecerReceta } from "../../utils/costeo.js";
import { restarDias } from "../../utils/fecha.js";
import { hoyEmpresa } from "../../utils/zonaHoraria.js";
import { ventasRecetaQuerySchema } from "./receta.schema.js";
import ApiError from "../../utils/ApiError.js";

export default class RecetaService {
    constructor(recetaRepository, empresaRepository) {
        this.recetaRepository = recetaRepository;
        this.empresaRepository = empresaRepository;
    }

    async #objetivo(empresa_id) {
        const emp = await this.empresaRepository.findById(empresa_id);
        return Number(emp?.food_cost_objetivo) || 30;
    }

    async getAllRecetas(empresa_id, opts) {
        const { rows, total } = await this.recetaRepository.findAll(empresa_id, opts);
        const obj = await this.#objetivo(empresa_id);
        return { rows: rows.map((r) => enriquecerReceta(r, obj)), total };
    }

    async getRecetaById(empresa_id, id) {
        const receta = await this.recetaRepository.findById(empresa_id, id);
        if (!receta) return receta;
        return enriquecerReceta(receta, await this.#objetivo(empresa_id));
    }

    async deleteReceta(empresa_id, id) {
        return await this.recetaRepository.remove(empresa_id, id);
    }

    async createReceta(empresa_id, data) {
        const receta = await this.recetaRepository.create(empresa_id, data);
        return enriquecerReceta(receta, await this.#objetivo(empresa_id));
    }

    async updateReceta(empresa_id, id, data) {
        const receta = await this.recetaRepository.update(empresa_id, id, data);
        if (!receta) return receta;
        return enriquecerReceta(receta, await this.#objetivo(empresa_id));
    }

    // Validación para revisar si la empresa existe para la receta que sea creada o actualizada
    async createRecetaConDetalle(empresa_id, data) {
        const receta = await this.recetaRepository.createConDetalle(empresa_id, data);
        const enriched = enriquecerReceta(receta, await this.#objetivo(empresa_id));
        return receta.ingredientes ? { ...enriched, ingredientes: receta.ingredientes } : enriched;
    }

    async getDetalle(receta_id) {
        return await this.recetaRepository.detalle(receta_id);
    }

    async previewCosteo(empresa_id, data) {
        return await calcularPreview(empresa_id, data);
    }

    // Mezcla de ventas por receta + costo % ponderado (ingeniería de menú).
    async getVentasPorReceta(empresa_id, { desde, hasta }) {
        const ayer = restarDias(await hoyEmpresa(empresa_id), 1);
        const dDesde = desde || restarDias(ayer, 29); // por defecto, últimos 30 días hasta ayer
        const dHasta = hasta || ayer;
        const parsed = ventasRecetaQuerySchema.safeParse({ desde: dDesde, hasta: dHasta });
        if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message, parsed.error.issues);

        const raw = await this.recetaRepository.ventasPorReceta(empresa_id, { desde: dDesde, hasta: dHasta });
        const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
        const recetas = raw.recetas.map((x) => {
            const ingreso = r2(x.ingreso);
            const ingreso_neto = r2(x.ingreso_neto);
            const costo_teorico = r2(x.costo_teorico);
            return {
                receta_id: x.receta_id,
                nombre: x.nombre,
                categoria: x.categoria,
                es_preparacion: x.es_preparacion,
                activo: x.activo,
                unidades: Number(x.unidades),
                ingreso,
                ingreso_neto,
                costo_teorico,
                costo_pct: ingreso_neto > 0 ? r2((costo_teorico / ingreso_neto) * 100) : null,
                utilidad: r2(ingreso_neto - costo_teorico),
            };
        });
        const sum = (k) => recetas.reduce((a, x) => a + x[k], 0);
        const tUnidades = sum("unidades");
        const tIngreso = r2(sum("ingreso"));
        const tNeto = r2(sum("ingreso_neto"));
        const tCosto = r2(sum("costo_teorico"));
        const totales = {
            unidades: tUnidades,
            ingreso: tIngreso,
            ingreso_neto: tNeto,
            costo_teorico: tCosto,
            costo_pct: tNeto > 0 ? r2((tCosto / tNeto) * 100) : null,
            utilidad: r2(tNeto - tCosto),
        };
        return {
            periodo: { desde: dDesde, hasta: dHasta },
            dias_importados: raw.dias_importados,
            dias_pos: raw.dias_pos,
            recetas,
            totales,
            sin_receta: raw.sin_receta,
        };
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
