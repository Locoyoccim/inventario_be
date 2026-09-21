import { z } from "zod";

const ingrediente = z.object({
    producto_id: z.coerce.number().int().positive(),
    cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
});

export const recetaCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    categoria: z.string().trim().min(1, "categoria es requerida"),
    precio_venta: z.coerce.number().min(0, "precio_venta debe ser >= 0"),
    activo: z.boolean().optional(),
    costo_produccion: z.coerce.number().min(0).optional(),
    proteccion_pct: z.coerce.number().min(0).optional(),
    ingredientes: z.array(ingrediente).min(1, "incluye al menos un ingrediente").optional(),
});

export const recetaUpdateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    categoria: z.string().trim().min(1, "categoria es requerida"),
    precio_venta: z.coerce.number().min(0, "precio_venta debe ser >= 0"),
    activo: z.boolean().optional(),
    costo_produccion: z.coerce.number().min(0).optional(),
    proteccion_pct: z.coerce.number().min(0).optional(),
});

export const recetaPreviewSchema = z.object({
    precio_venta: z.coerce.number().min(0).optional(),
    costo_produccion: z.coerce.number().min(0).optional(),
    proteccion_pct: z.coerce.number().min(0).optional(),
    ingredientes: z.array(ingrediente).min(1, "incluye al menos un ingrediente"),
});
