export default class ProductoService {
    constructor(productoRepository) {
        this.productoRepository = productoRepository;
    }

    async getAllProductos(empresa_id) {
        return await this.productoRepository.findAll(empresa_id);
    }

    async getProductoById(id, empresa_id) {
        return await this.productoRepository.findById(id, empresa_id);
    }

    async createProducto(data, empresa_id) {
        return await this.productoRepository.createProducto(data, empresa_id);
    }

    async existsProducto(id) {
        return await this.productoRepository.exitsProducto(id);
    }

    async updateProducto(id, data, empresa_id) {
        return await this.productoRepository.updateProducto(id, data, empresa_id);
    }

    async deleteProducto(id, empresa_id) {
        return await this.productoRepository.deleteProducto(id, empresa_id);
    }
}
