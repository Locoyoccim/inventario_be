import { z } from "zod";
export const usuarioCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    codigo_ingreso: z.string().trim().min(1, "codigo_ingreso es requerido"),
    puesto: z.string().trim().optional(),
    is_admin: z.boolean().optional(),
    is_owner: z.boolean().optional(),
    role_id: z.coerce.number().int().positive().optional(),
    email: z.string().trim().toLowerCase().email("email inválido").optional(),
    password: z.string().min(6, "password debe tener al menos 6 caracteres").optional(),
});
export const usuarioUpdateSchema = usuarioCreateSchema;
