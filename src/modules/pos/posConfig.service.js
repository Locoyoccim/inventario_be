export default class PosConfigService {
    constructor(posConfigRepository) {
        this.repo = posConfigRepository;
    }

    listarAreas(e) { return this.repo.listarAreas(e); }
    crearArea(e, data) { return this.repo.crearArea(e, data); }
    actualizarArea(e, id, data) { return this.repo.actualizarArea(e, id, data); }

    listarMesas(e, incluirInactivas) { return this.repo.listarMesas(e, incluirInactivas); }
    crearMesa(e, data) { return this.repo.crearMesa(e, data); }
    actualizarMesa(e, id, data) { return this.repo.actualizarMesa(e, id, data); }

    listarAsignacion(e) { return this.repo.listarAsignacion(e); }
    asignarAreaCategoria(e, id, area_id) { return this.repo.asignarAreaCategoria(e, id, area_id); }
    asignarAreaArticulo(e, tipo, id, area_id) { return this.repo.asignarAreaArticulo(e, tipo, id, area_id); }

    menu(e) { return this.repo.menu(e); }
}
