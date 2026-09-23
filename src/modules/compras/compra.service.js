export default class CompraService {
    constructor(compraRepository, empresaRepository) {
        this.compraRepository = compraRepository;
        this.empresaRepository = empresaRepository;
    }
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
    async getAll(empresa_id, opts) {
        return await this.compraRepository.findAll(empresa_id, opts);
    }
    async getById(empresa_id, id) {
        return await this.compraRepository.findById(empresa_id, id);
    }
    async crear(empresa_id, data) {
        return await this.compraRepository.crear(empresa_id, data);
    }
}
