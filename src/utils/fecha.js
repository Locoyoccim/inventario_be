// Validación de fechas para el borde (zod): formato, existencia real y no futura.
export function esFechaReal(str) {
    if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const [y, m, d] = str.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// "Hoy" en la zona horaria del negocio (por defecto America/Mexico_City), no en UTC:
// entre las 18:00 y medianoche en México, UTC ya es "mañana".
export function hoyISO(now = new Date(), tz = process.env.TZ_NEGOCIO || "America/Mexico_City") {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Comparación lexicográfica: válida para cadenas YYYY-MM-DD.
export function noFutura(str, now = new Date()) {
    return str <= hoyISO(now);
}
