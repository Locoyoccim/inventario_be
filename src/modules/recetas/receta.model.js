export default class Receta {
    constructor(id, nombre, categoria, precio_venta, costo_total, margen, activo, created_at, empresa_id) {
        this.id = id;
        this.nombre = nombre;
        this.categoria = categoria;
        this.precio_venta = precio_venta;
        this.costo_total = costo_total;
        this.margen = margen;
        this.activo = activo;
        this.created_at = created_at;
        this.empresa_id = empresa_id;
    }
}