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

    async confirmar(empresa_id, producciones, usuario_id) {
        return await this.produccionRepository.confirmar(empresa_id, producciones, usuario_id);
    }
}
