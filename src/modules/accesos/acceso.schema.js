import { z } from "zod";

// Alta/cambio del acceso de un usuario a otra empresa (solo el maestro de plataforma). Cada acceso lleva SU rol: `is_admin` y
// `role_id` valen únicamente en esa empresa. Por defecto entra como Admin (el destino siempre es un Owner/Admin).
export const concederAccesoSchema = z.object({
    is_admin: z.boolean().optional(),
    role_id: z.number().int().positive().nullable().optional(),
});

// Listado del maestro: filtros opcionales por empresa base y por nombre/correo.
export const listarAccesosSchema = z.object({
    empresa_id: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(80).optional(),
});

// Empresa activa de la sesión (cambio de empresa dentro del panel).
export const empresaActivaSchema = z.object({
    empresa_id: z.coerce.number().int().positive(),
});
