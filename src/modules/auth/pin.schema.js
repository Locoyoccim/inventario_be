import { z } from "zod";

export const registrarDispositivoSchema = z.object({
    codigo: z.string().trim().min(8, "Escribe el código completo").max(20),
});

export const entrarConPinSchema = z.object({
    usuario_id: z.coerce.number().int().positive(),
    pin: z.string().regex(/^\d{4,6}$/, "El PIN debe tener de 4 a 6 dígitos"),
});

export const dispositivoSchema = z.object({
    nombre: z.string().trim().min(1, "El nombre es requerido").max(80),
});

export const definirPinSchema = z.object({
    pin: z.string().regex(/^\d{4,6}$/, "El PIN debe tener de 4 a 6 dígitos"),
});
