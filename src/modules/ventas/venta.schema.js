import { z } from "zod";

const linea = z.object({
    nombre_pos: z.string().trim().min(1),
    cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
});

export const ventaImportSchema = z
    .object({
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD"),
        lineas: z.array(linea).optional(),
        csv: z.string().optional(),
    })
    .refine(
        (d) => (d.lineas && d.lineas.length > 0) || (d.csv && d.csv.trim().length > 0),
        { message: "Envía 'lineas' [{nombre_pos, cantidad}] o 'csv'", path: ["lineas"] }
    );
