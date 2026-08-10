export default class InventarioService {
    constructor(inventarioRepository, productoRepository, empresaRepository) {
        this.inventarioRepository = inventarioRepository;
        this.productoRepository = productoRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllInventario(empresa_id) {
        return await this.inventarioRepository.findAll(empresa_id);
    }

    async getInventarioById(id, empresa_id) {
        return await this.inventarioRepository.findById(id, empresa_id);
    }

    async createInventario(data) {
        return await this.inventarioRepository.create(data);
    }

    async updateInventario(id, empresa_id, data) {
        return await this.inventarioRepository.update(id, empresa_id, data);
    }

    async deleteInventario(id, empresa_id) {
        return await this.inventarioRepository.remove(id, empresa_id);
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }

    async existsProducto(producto_id) {
        return await this.productoRepository.exitsProducto(producto_id);
    }

    async existsProductoEnEmpresa(producto_id, empresa_id) {
        const producto = await this.productoRepository.findById(producto_id, empresa_id);
        return Boolean(producto);
    }
}
