export default class CategoriaService {
    constructor(categoriaRepository, empresaRepository) {
        this.categoriaRepository = categoriaRepository;
        this.empresaRepository = empresaRepository;
    }
    async existsEmpresa(empresa_id) { return await this.empresaRepository.existsEmpresa(empresa_id); }
    async getAll(empresa_id, opts = {}) { return await this.categoriaRepository.findAll(empresa_id, opts); }
    async crear(empresa_id, data) { return await this.categoriaRepository.create(empresa_id, data); }
    async actualizar(empresa_id, id, data) { return await this.categoriaRepository.update(empresa_id, id, data); }
    async eliminar(empresa_id, id, reasignar_a = null) { return await this.categoriaRepository.remove(empresa_id, id, reasignar_a); }
}
