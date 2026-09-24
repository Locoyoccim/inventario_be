// Lógica pura de compras (sin BD): política de costeo y normalización de líneas.
import ApiError from "../../utils/ApiError.js";

// Política de costeo: ÚLTIMO COSTO. El costo del producto salta al precio de la última
// compra (costo de reposición); no se mezcla con el inventario previo.
export function costoUltimaCompra(precioCompra) {
    return Number(precioCompra);
}

// Normaliza una línea de compra: exige cantidad > 0 y deriva costo_total / precio unitario.
// Acepta 'costo_total' (lo pagado) o 'costo_unitario'.
export function normalizarLineaCompra(linea) {
    const producto_id = Number(linea.producto_id);
    const cantidad = Number(linea.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
        throw ApiError.badRequest(`cantidad inválida para el producto ${producto_id}`);
    }
    const costoTotal = linea.costo_total != null
        ? Number(linea.costo_total)
        : Number(linea.costo_unitario) * cantidad;
    if (!Number.isFinite(costoTotal) || costoTotal < 0) {
        throw ApiError.badRequest(`costo inválido para el producto ${producto_id}`);
    }
    return { cantidad, costoTotal, precioCompra: costoTotal / cantidad };
}

// Persistencia del costo reutilizando la columna generada:
// costo_presentacion = costo_unitario * cantidad_presentacion (=> costo_unitario se mantiene).
export function costoPresentacionDesde(costoUnitario, cantidadPresentacion) {
    return Number((Number(costoUnitario) * Number(cantidadPresentacion)).toFixed(4));
}
