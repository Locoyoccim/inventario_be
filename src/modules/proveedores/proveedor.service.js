export default class ProveedorService {
    constructor(proveedorRepository, empresaRepository) {
        this.proveedorRepository = proveedorRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllProveedores() {
        return await this.proveedorRepository.findAll();
    }

    async getProveedorById(id) {
        return await this.proveedorRepository.findByID(id);
    }

    async deleteProveedor(id) {
        return await this.proveedorRepository.remove(id);
    }

    async createProveedor(data) {
        return await this.proveedorRepository.create(data);
    }

    async updateProveedor(id, data) {
        return await this.proveedorRepository.update(id, data);
    }

    // Validación para revisar si la empresa existe para el proveedor que sea crea
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
