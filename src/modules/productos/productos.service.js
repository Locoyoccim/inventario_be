export default class ProductoService {
    constructor(productoRepository) {
        this.productoRepository = productoRepository;
    }

    async getAllProductos(empresa_id, opts) {
        return await this.productoRepository.findAll(empresa_id, opts);
    }

    async getProductoById(id, empresa_id) {
        return await this.productoRepository.findById(id, empresa_id);
    }

    async createProducto(data, empresa_id) {
        return await this.productoRepository.createProducto(data, empresa_id);
    }

    async updateProducto(id, data, empresa_id) {
        return await this.productoRepository.updateProducto(id, data, empresa_id);
    }

    async actualizarLimites(id, empresa_id, data) {
        return await this.productoRepository.actualizarLimites(id, empresa_id, data);
    }

    async deleteProducto(id, empresa_id) {
        return await this.productoRepository.deleteProducto(id, empresa_id);
    }

    async getUso(empresa_id, id) {
        return await this.productoRepository.uso(empresa_id, id);
    }
}
