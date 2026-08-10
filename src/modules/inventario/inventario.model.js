export default class Inventario {
    constructor(id, producto_id, stock_actual, stock_minimo, updated_at, empresa_id) {
        this.id = id;
        this.empresa_id = empresa_id;
        this.producto_id = producto_id;
        this.stock_actual = stock_actual;
        this.stock_minimo = stock_minimo;
        this.updated_at = updated_at;
    }
}
