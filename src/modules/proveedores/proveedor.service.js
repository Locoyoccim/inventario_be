export default class ProveedorService {
    constructor(proveedorRepository, empresaRepository) {
        this.proveedorRepository = proveedorRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllProveedores(empresa_id) {
        return await this.proveedorRepository.findAll(empresa_id);
    }

    async getProveedorById(empresa_id, id) {
        return await this.proveedorRepository.findByID(empresa_id, id);
    }

    async deleteProveedor(id, empresa_id) {
        return await this.proveedorRepository.remove(id, empresa_id);
    }

    async createProveedor(data, empresa_id) {
        return await this.proveedorRepository.create(data, empresa_id);
    }

    async updateProveedor(id, data, empresa_id) {
        return await this.proveedorRepository.update(id, data, empresa_id);
    }

    // Validación para revisar si la empresa existe para el proveedor que sea creado o actualizado
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
