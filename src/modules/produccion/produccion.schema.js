import { z } from "zod";

const produccionItem = z.object({
    receta_id: z.coerce.number().int().positive(),
    lotes: z.coerce.number().int().positive("lotes debe ser un entero >= 1"),
});

export const produccionConfirmarSchema = z.object({
    producciones: z.array(produccionItem).min(1, "incluye al menos una producción"),
});
