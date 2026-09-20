export default class VentaDiaria {
    constructor(id, empresa_id, fecha, total_lineas, total_unidades, procesado_at) {
        this.id = id;
        this.empresa_id = empresa_id;
        this.fecha = fecha;
        this.total_lineas = total_lineas;
        this.total_unidades = total_unidades;
        this.procesado_at = procesado_at;
    }
}
