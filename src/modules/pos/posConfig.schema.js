import { z } from "zod";

const nombre = (max) => z.string().trim().min(1, "nombre es requerido").max(max, `máximo ${max} caracteres`);
const areaId = z.coerce.number().int().positive().nullable();

export const areaCreateSchema = z.object({
    nombre: nombre(60),
    imprime: z.boolean().optional(),
    pantalla: z.boolean().optional(),
    tiempo_objetivo_min: z.coerce.number().int().min(1).max(240).optional(),
    es_default: z.boolean().optional(),
});

// es_default solo admite true: el default se cambia eligiendo otra área, nunca dejando ninguna.
export const areaUpdateSchema = z
    .object({
        nombre: nombre(60).optional(),
        imprime: z.boolean().optional(),
        pantalla: z.boolean().optional(),
        tiempo_objetivo_min: z.coerce.number().int().min(1).max(240).optional(),
        es_default: z.literal(true).optional(),
        activo: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: "Envía al menos un campo" });

export const mesaCreateSchema = z.object({
    nombre: nombre(40),
    zona: z.string().trim().max(60).optional(),
    capacidad: z.coerce.number().int().positive("capacidad debe ser mayor a 0").optional(),
    orden: z.coerce.number().int().min(0).optional(),
});

export const mesaUpdateSchema = mesaCreateSchema
    .partial()
    .extend({ activo: z.boolean().optional() })
    .refine((d) => Object.keys(d).length > 0, { message: "Envía al menos un campo" });

export const asignarAreaSchema = z.object({ area_id: areaId });
