export default class ProveedorService {
    constructor(proveedorRepository, empresaRepository) {
        this.proveedorRepository = proveedorRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllProveedores(empresa_id, opts = {}) {
        return await this.proveedorRepository.findAll(empresa_id, opts);
    }

    async getProveedorById(empresa_id, id) {
        return await this.proveedorRepository.findByID(empresa_id, id);
    }

    async deleteProveedor(id, empresa_id) {
        return await this.proveedorRepository.remove(id, empresa_id);
    }

    async eliminarDefinitivo(empresa_id, id) {
        return await this.proveedorRepository.eliminarDefinitivo(empresa_id, id);
    }

    async fusionarProveedor(empresa_id, id, destino_id) {
        return await this.proveedorRepository.fusionar(empresa_id, id, destino_id);
    }

    async resumenProveedor(empresa_id, id) {
        return await this.proveedorRepository.resumenProveedor(empresa_id, id);
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
