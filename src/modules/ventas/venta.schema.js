import { z } from "zod";

// Verifica que la fecha exista de verdad (2026-02-31 tiene formato válido pero no existe).
const esFechaReal = (str) => {
    const [y, m, d] = str.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const linea = z.object({
    nombre_pos: z.string().trim().min(1),
    cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
});

export const ventaImportSchema = z
    .object({
        fecha: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD")
            .refine(esFechaReal, "fecha inexistente (revisa día/mes)"),
        lineas: z.array(linea).optional(),
        csv: z.string().optional(),
    })
    .refine(
        (d) => (d.lineas && d.lineas.length > 0) || (d.csv && d.csv.trim().length > 0),
        { message: "Envía 'lineas' [{nombre_pos, cantidad}] o 'csv'", path: ["lineas"] }
    );

// Preview: mismas fuentes que import (líneas o CSV) pero sin fecha ni persistencia.
export const ventaPreviewSchema = z
    .object({
        lineas: z.array(linea).optional(),
        csv: z.string().optional(),
    })
    .refine(
        (d) => (d.lineas && d.lineas.length > 0) || (d.csv && d.csv.trim().length > 0),
        { message: "Envía 'lineas' [{nombre_pos, cantidad}] o 'csv'", path: ["lineas"] }
    );
