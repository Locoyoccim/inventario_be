import { z } from "zod";
export const empresaCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    titular: z.string().trim().optional(),
    telefono: z.string().trim().optional(),
    email: z.string().trim().optional(),
    domicilio: z.string().trim().optional(),
});
export const empresaUpdateSchema = empresaCreateSchema;

export const empresaConfigSchema = z
    .object({
        iva_pct: z.coerce.number().min(0).max(100).optional(),
        precios_incluyen_iva: z.boolean().optional(),
        food_cost_objetivo: z.coerce.number().gt(0, "debe ser > 0").lt(100, "debe ser < 100").optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: "Envía al menos un campo de configuración" });
