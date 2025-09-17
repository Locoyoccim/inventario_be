export default class ProductoService {
    constructor(productoRepository) {
        this.productoRepository = productoRepository;
    }

    async getAllProductos() {
        return await this.productoRepository.findAll();
    }

    async getProductoById(id) {
        return await this.productoRepository.findById(id);
    }

    async createProducto(data) {
        return await this.productoRepository.createProducto(data);
    }

    async existsProducto(id) {
        return await this.productoRepository.exitsProducto(id);
    }

    async updateProducto(id, data) {
        return await this.productoRepository.updateProducto(id, data);
    }

    async deleteProducto(id) {
        return await this.productoRepository.deleteProducto(id);
    }
}
