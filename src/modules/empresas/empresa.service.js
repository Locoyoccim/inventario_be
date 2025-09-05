export default class EmpresaService {
    constructor(empresaRepository) {
        this.empresaRepository = empresaRepository;
    }

    async getAllEmpresas() {
        return await this.empresaRepository.findAll();
    }

    async getEmpresaById(id) {
        return await this.empresaRepository.findById(id);
    }

    async createEmpresa(data) {
        return await this.empresaRepository.create(data);
    }

    async updateEmpresa(id, data) {
        return await this.empresaRepository.update(id, data);
    }

    async deleteEmpresa(id) {
        return await this.empresaRepository.remove(id);
    }
}
