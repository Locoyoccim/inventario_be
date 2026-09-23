// Normaliza los filtros del kardex (query -> opciones del repositorio).
export const TIPOS_MOVIMIENTO = ["COMPRA", "VENTA", "MERMA", "AJUSTE", "DEVOLUCION", "PRODUCCION"];

const esFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseFiltrosKardex(query = {}) {
    const productoId = Number.parseInt(query.producto_id, 10);
    const tipo = String(query.tipo ?? "").toUpperCase();
    const sentido = String(query.sentido ?? "").toLowerCase();
    return {
        productoId: Number.isInteger(productoId) && productoId > 0 ? productoId : null,
        tipo: TIPOS_MOVIMIENTO.includes(tipo) ? tipo : null,
        desde: esFecha(query.desde) ? query.desde : null,
        hasta: esFecha(query.hasta) ? query.hasta : null,
        // entrada = el movimiento subio el stock; salida = lo bajo (AJUSTE puede ser cualquiera).
        sentido: sentido === "entrada" || sentido === "salida" ? sentido : null,
    };
}
