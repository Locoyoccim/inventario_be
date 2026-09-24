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
// Update: password opcional (solo si se cambia), activo para activar/desactivar; is_owner no se toca.
export const usuarioUpdateSchema = usuarioCreateSchema
    .omit({ is_owner: true })
    .extend({ activo: z.boolean().optional(), forzar_cierre_sesion: z.boolean().optional() });
