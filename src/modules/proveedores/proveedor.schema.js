import { z } from "zod";
export const proveedorCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    telefono: z.string().trim().optional(),
    email: z.string().trim().optional(),
    domicilio: z.string().trim().optional(),
});
export const proveedorUpdateSchema = proveedorCreateSchema;
