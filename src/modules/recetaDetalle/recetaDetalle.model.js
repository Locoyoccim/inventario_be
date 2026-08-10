export default class RecetaDetalle {
    constructor(id, receta_id, producto_id, cantidad, costo_unitario, costo_final) {
        this.id = id;
        this.receta_id = receta_id;
        this.producto_id = producto_id;
        this.cantidad = cantidad;
        this.costo_unitario = costo_unitario;
        this.costo_final = costo_final;
    }
}