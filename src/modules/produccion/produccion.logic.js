// Lógica pura de producción (sin BD): validación y cálculo de cantidades.
// Extraída del repositorio para poder probarla sin Postgres (D2).
import ApiError from "../../utils/ApiError.js";

// Normaliza y valida el nº de lotes: entero >= 1.
export function normalizarLotes(lotes, recetaId) {
    const n = Math.floor(Number(lotes));
    if (!Number.isFinite(n) || n < 1) {
        throw ApiError.badRequest(`lotes debe ser un entero >= 1 (receta ${recetaId})`);
    }
    return n;
}

// Regla de negocio: solo se produce lo que es preparación y tiene producto elaborado.
export function validarPreparacion(receta, recetaId) {
    if (!receta.es_preparacion || !receta.producto_elaborado_id) {
        throw ApiError.badRequest(`La receta ${recetaId} no es una preparación`);
    }
}

// Unidades producidas = rendimiento * lotes (rendimiento 0/None => 1).
export function cantidadProducida(rendimiento, nLotes) {
    const r = Number(rendimiento) || 1;
    return Number((r * nLotes).toFixed(3));
}

// Insumo consumido por lote = cantidad del escandallo * lotes.
export function cantidadInsumo(cantidadReceta, nLotes) {
    return Number((Number(cantidadReceta) * nLotes).toFixed(3));
}

// Sugerencia par-level: cuánto producir para reponer al menos el mínimo, en lotes enteros.
export function calcularSugerencia(stockActual, stockMinimo, rendimiento) {
    const r = Number(rendimiento) || 1;
    const faltante = Number(stockMinimo) - Number(stockActual);
    const lotes = Math.max(1, Math.ceil(faltante / r));
    return {
        rendimiento: r,
        faltante: Number(faltante.toFixed(3)),
        lotes,
        cantidad_a_producir: Number((lotes * r).toFixed(3)),
    };
}
