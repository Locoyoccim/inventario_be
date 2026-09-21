import { z } from "zod";

const idOpc = z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.coerce.number().int().positive().optional()
);

export const posMapItemSchema = z.object({
    nombre_pos: z.string().trim().min(1, "nombre_pos es requerido"),
    tipo: z.enum(["RECETA", "INSUMO", "IGNORAR"]),
    receta_id: idOpc,
    producto_id: idOpc,
    factor: z.coerce.number().positive().optional(),
});

// El bulk acepta un arreglo directo o { mapeos: [...] }
export const posMapBulkSchema = z.union([
    z.array(posMapItemSchema).min(1),
    z.object({ mapeos: z.array(posMapItemSchema).min(1) }),
]);
