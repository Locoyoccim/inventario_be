export default class ConteoService {
    constructor(conteoRepository, empresaRepository) {
        this.conteoRepository = conteoRepository;
        this.empresaRepository = empresaRepository;
    }
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
    async plantilla(empresa_id) {
        return await this.conteoRepository.plantilla(empresa_id);
    }
    async getAll(empresa_id, opts) {
        return await this.conteoRepository.findAll(empresa_id, opts);
    }
    async getById(empresa_id, id) {
        return await this.conteoRepository.findById(empresa_id, id);
    }
    async crear(empresa_id, data) {
        return await this.conteoRepository.crear(empresa_id, data);
    }
}
