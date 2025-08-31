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
}
