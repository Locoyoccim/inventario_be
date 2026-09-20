export default class PosMapService {
    constructor(posMapRepository, empresaRepository) {
        this.posMapRepository = posMapRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAll(empresa_id) {
        return await this.posMapRepository.findAll(empresa_id);
    }

    async getById(id, empresa_id) {
        return await this.posMapRepository.findById(id, empresa_id);
    }

    async upsert(empresa_id, data) {
        return await this.posMapRepository.upsert(empresa_id, data);
    }

    async upsertBulk(empresa_id, filas) {
        return await this.posMapRepository.upsertBulk(empresa_id, filas);
    }

    async update(id, empresa_id, data) {
        return await this.posMapRepository.update(id, empresa_id, data);
    }

    async remove(id, empresa_id) {
        return await this.posMapRepository.remove(id, empresa_id);
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
