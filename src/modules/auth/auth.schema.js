import { z } from "zod";
export const loginSchema = z.object({
    email: z.string().trim().toLowerCase().min(1, "email es requerido"),
    password: z.string().min(1, "password es requerido"),
});

export const setupSchema = z.object({
    empresa_id: z.coerce.number().int().positive(),
    nombre: z.string().trim().min(1, "nombre es requerido"),
    email: z.string().trim().toLowerCase().email("email inválido"),
    password: z.string().min(6, "password debe tener al menos 6 caracteres"),
    codigo_ingreso: z.string().trim().min(1, "codigo_ingreso es requerido"),
    puesto: z.string().trim().min(1, "puesto es requerido"),
    role_id: z.coerce.number().int().positive("role_id es requerido"),
});
