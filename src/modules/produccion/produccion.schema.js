import { z } from "zod";

const produccionItem = z.object({
    receta_id: z.coerce.number().int().positive(),
    lotes: z.coerce.number().int().positive("lotes debe ser un entero >= 1"),
    // Opcional: lo que realmente rindio el lote (si se peso/conto al terminar). Si viene y
    // difiere de lotes x rendimiento, se ajusta la existencia a lo real (merma o rendimiento extra).
    cantidad_real: z.coerce.number().min(0).optional(),
});

export const produccionConfirmarSchema = z.object({
    producciones: z.array(produccionItem).min(1, "incluye al menos una producción"),
});

export const produccionAnularSchema = z.object({
    motivo: z.string().trim().min(1, "motivo es requerido"),
});
