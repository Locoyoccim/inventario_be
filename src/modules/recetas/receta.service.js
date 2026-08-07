export default class RecetaService {
    constructor(recetaRepository, empresaRepository) {
        this.recetaRepository = recetaRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllRecetas(empresa_id) {
        return await this.recetaRepository.findAll(empresa_id);
    }

    async getRecetaById(empresa_id, id) {
        return await this.recetaRepository.findById(empresa_id, id);
    }

    async deleteReceta(empresa_id, id) {
        return await this.recetaRepository.remove(empresa_id, id);
    }

    async createReceta(empresa_id, data) {
        return await this.recetaRepository.create(empresa_id, data);
    }

    async updateReceta(empresa_id, id, data) {
        return await this.recetaRepository.update(empresa_id, id, data);
    }

    // Validación para revisar si la empresa existe para la receta que sea creada o actualizada
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
