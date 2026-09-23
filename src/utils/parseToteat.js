import { normalizar } from "./normalize.js";

// Convierte el CSV de "Productos vendidos" de Toteat en filas limpias.
// Formato de entrada (columnas variables por mesero, Total siempre al final):
//   Productos,Danya Martinez,Genesis,Rogelio,Total
//   Latte,1.00,2.00,1.00,4.00
//   ...
//   TOTAL,30.00,43.00,42.00,115.00
//   Propinas,$0.00,$165.00,$0.00,$165.00
//
// Devuelve: [{ nombre_pos, cantidad }] usando la columna Total.
// Ignora: encabezado, fila TOTAL y fila Propinas.
export function parseToteatCsv(texto) {
    const lineas = String(texto ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    const filas = [];
    const IGNORAR_FILA = new Set(["productos", "total", "propinas"]);

    for (const linea of lineas) {
        const partes = linea.split(",");
        if (partes.length < 2) continue;

        const nombre = partes[0].trim();
        if (!nombre) continue;
        if (IGNORAR_FILA.has(normalizar(nombre))) continue; // header + totales

        // Total = última columna. Limpia símbolos ($, espacios) y separadores de miles.
        const totalRaw = partes[partes.length - 1].replace(/[^0-9.-]/g, "");
        const cantidad = Number.parseFloat(totalRaw);
        if (!Number.isFinite(cantidad) || cantidad === 0) continue;

        filas.push({ nombre_pos: nombre, cantidad });
    }

    return filas;
}

export default parseToteatCsv;
