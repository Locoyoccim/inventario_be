export default class Producto {
    constructor(
        id,
        producto,
        stock_actual,
        stock_minimo,
        unidad_medida,
        proveedor_id,
        categoria,
        empresa_id,
        cantidad_presentacion,
        costo_presentacion,
        costo_unitario
    ) {
        this.id = id;
        this.producto = producto;
        this.stock_actual = stock_actual;
        this.stock_minimo = stock_minimo;
        this.unidad_medida = unidad_medida;
        this.proveedor_id = proveedor_id;
        this.categoria = categoria;
        this.empresa_id = empresa_id;
        this.cantidad_presentacion = cantidad_presentacion;
        this.costo_presentacion = costo_presentacion;
        this.costo_unitario = costo_unitario;
    }
}
