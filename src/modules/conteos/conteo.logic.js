// Lógica pura de conteo físico (sin BD): validación de líneas y resumen de varianza.
import ApiError from "../../utils/ApiError.js";

// Requiere al menos una línea y sin productos repetidos.
export function validarLineasConteo(lineas) {
    if (!Array.isArray(lineas) || lineas.length === 0) {
        throw ApiError.badRequest("Se requiere al menos una línea en 'lineas'");
    }
    const vistos = new Set();
    for (const l of lineas) {
        const k = Number(l.producto_id);
        if (vistos.has(k)) throw ApiError.badRequest(`Producto ${k} repetido en el conteo`);
        vistos.add(k);
    }
}

// Resume la varianza del conteo: cuántas líneas con merma/sobrante y sus valores.
// merma = varianza negativa, sobrante = positiva; valor_neto = suma de todo.
export function resumirVarianza(detalle) {
    const merma = detalle.filter((d) => d.variacion < 0);
    const sobrante = detalle.filter((d) => d.variacion > 0);
    const sum = (arr) => Number(arr.reduce((a, d) => a + d.valor_variacion, 0).toFixed(2));
    return {
        lineas: detalle.length,
        con_merma: merma.length,
        con_sobrante: sobrante.length,
        valor_merma: sum(merma),
        valor_sobrante: sum(sobrante),
        valor_neto: Number(detalle.reduce((a, d) => a + d.valor_variacion, 0).toFixed(2)),
    };
}
