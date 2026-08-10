export default class InventarioService {
    constructor(inventarioRepository, empresaRepository) {
        this.inventarioRepository = inventarioRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllInventario(empresa_id) {
        return await this.inventarioRepository.findAll(empresa_id);
    }

    async getInventarioById(id, empresa_id) {
        return await this.inventarioRepository.findById(id, empresa_id);
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
