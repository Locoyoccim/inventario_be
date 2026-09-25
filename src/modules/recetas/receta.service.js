import { calcularPreview, enriquecerReceta } from "../../utils/costeo.js";

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

    async previewCosteo(empresa_id, data) {
        return await calcularPreview(empresa_id, data);
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
