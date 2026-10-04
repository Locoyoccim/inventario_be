import { z } from "zod";
export const empresaConfigSchema = z
    .object({
        iva_pct: z.coerce.number().min(0).max(100).optional(),
        precios_incluyen_iva: z.boolean().optional(),
        food_cost_objetivo: z.coerce.number().gt(0, "debe ser > 0").lt(100, "debe ser < 100").optional(),
        // Nombre IANA (America/Mexico_City, Europe/Madrid...); el servicio lo valida contra Postgres.
        zona_horaria: z.string().trim().min(1).max(64).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: "Envía al menos un campo de configuración" });
