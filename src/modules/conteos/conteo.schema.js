import { z } from "zod";

const lineaConteo = z.object({
    producto_id: z.coerce.number().int().positive(),
    stock_fisico: z.coerce.number().min(0, "stock_fisico debe ser >= 0"),
    // Existencia que el sistema tenía al EMPEZAR a contar (la que trae la plantilla). Con ella, lo vendido o
    // recibido mientras se contaba no se confunde con una diferencia: el ajuste es contado - base.
    stock_teorico_base: z.coerce.number().optional(),
});

export const conteoCreateSchema = z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD").optional(),
    motivo: z.string().trim().optional(),
    lineas: z.array(lineaConteo).min(1, "incluye al menos una línea de conteo"),
});

export const conteoAnularSchema = z.object({
    motivo: z.string().trim().min(1, "motivo es requerido"),
});
