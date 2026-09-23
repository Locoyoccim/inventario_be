import { z } from "zod";

const lineaConteo = z.object({
    producto_id: z.coerce.number().int().positive(),
    stock_fisico: z.coerce.number().min(0, "stock_fisico debe ser >= 0"),
});

export const conteoCreateSchema = z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD").optional(),
    motivo: z.string().trim().optional(),
    lineas: z.array(lineaConteo).min(1, "incluye al menos una línea de conteo"),
});
