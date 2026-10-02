export default class ProduccionService {
    constructor(produccionRepository, empresaRepository) {
        this.produccionRepository = produccionRepository;
        this.empresaRepository = empresaRepository;
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }

    async getSugerencias(empresa_id) {
        return await this.produccionRepository.sugerencias(empresa_id);
    }

    async planificar(empresa_id, receta_id, lotes) {
        return await this.produccionRepository.planificar(empresa_id, receta_id, lotes);
    }

    async confirmar(empresa_id, producciones, usuario_id) {
        return await this.produccionRepository.confirmar(empresa_id, producciones, usuario_id);
    }

    async getAll(empresa_id, opts) {
        return await this.produccionRepository.findAll(empresa_id, opts);
    }

    async getById(empresa_id, id) {
        return await this.produccionRepository.findById(empresa_id, id);
    }

    async anular(empresa_id, id, usuario_id, motivo) {
        return await this.produccionRepository.anular(empresa_id, id, usuario_id, motivo);
    }
}
