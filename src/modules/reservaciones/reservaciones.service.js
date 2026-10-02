export default class ReservacionService {
    constructor(reservacionRepository) {
        this.repo = reservacionRepository;
    }

    listar(empresa_id, filtros) { return this.repo.listar(empresa_id, filtros); }
    crear(empresa_id, data, usuario_id) { return this.repo.crear(empresa_id, data, usuario_id); }
    actualizar(empresa_id, id, data) { return this.repo.actualizar(empresa_id, id, data); }
    cambiarEstado(empresa_id, id, estado) { return this.repo.cambiarEstado(empresa_id, id, estado); }
    eliminar(empresa_id, id) { return this.repo.eliminar(empresa_id, id); }
}
