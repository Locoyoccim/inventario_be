import { z } from "zod";
export const empresaCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    titular: z.string().trim().optional(),
    telefono: z.string().trim().optional(),
    email: z.string().trim().optional(),
    domicilio: z.string().trim().optional(),
});
export const empresaUpdateSchema = empresaCreateSchema;
