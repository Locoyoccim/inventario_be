import { z } from "zod";
export const recetaDetalleSchema = z.object({
    producto_id: z.coerce.number().int().positive("producto_id es requerido"),
    cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
});
