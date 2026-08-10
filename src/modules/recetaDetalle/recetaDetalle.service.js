export default class RecetaDetalleService {
    constructor(recetaDetalleRepository, recetaRepository) {
        this.recetaDetalleRepository = recetaDetalleRepository;
        this.recetaRepository = recetaRepository;
    }

    async getAllRecetaDetalles(receta_id) {
        return await this.recetaDetalleRepository.findAll(receta_id);
    }

    async getRecetaDetalleById(receta_id, id) {
        return await this.recetaDetalleRepository.findById(receta_id, id);
    }

    async deleteRecetaDetalle(receta_id, id) {
        return await this.recetaDetalleRepository.remove(receta_id, id);
    }

    async createRecetaDetalle(receta_id, data) {
        return await this.recetaDetalleRepository.create(receta_id, data);
    }

    async updateRecetaDetalle(receta_id, id, data) {
        return await this.recetaDetalleRepository.update(receta_id, id, data);
    }

    // Validación para revisar si la receta existe para el detalle de receta que sea creado o actualizado
    async existsReceta(receta_id) {
        return await this.recetaRepository.existsReceta(receta_id);
    }
}
