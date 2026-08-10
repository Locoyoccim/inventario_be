export default class MovimientoService {
    constructor(movimientoRepository) {
        this.movimientoRepository = movimientoRepository;
    }

    async getMovimientos(producto_id, empresa_id) {
        return await this.movimientoRepository.findAll(producto_id, empresa_id);
    }

    async registrarMovimiento(producto_id, empresa_id, data) {
        return await this.movimientoRepository.registrar(producto_id, empresa_id, data);
    }
}
