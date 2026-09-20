export default class PosMap {
    constructor(id, empresa_id, nombre_pos, tipo, receta_id, producto_id, factor, created_at) {
        this.id = id;
        this.empresa_id = empresa_id;
        this.nombre_pos = nombre_pos;
        this.tipo = tipo;              // 'RECETA' | 'INSUMO' | 'IGNORAR'
        this.receta_id = receta_id;
        this.producto_id = producto_id;
        this.factor = factor;
        this.created_at = created_at;
    }
}
