import { z } from "zod";

const ingrediente = z.object({
    producto_id: z.coerce.number().int().positive(),
    cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
});

export const recetaCreateSchema = z
    .object({
        nombre: z.string().trim().min(1, "nombre es requerido"),
        categoria: z.string().trim().min(1, "categoria es requerida"),
        precio_venta: z.coerce.number().min(0, "precio_venta debe ser >= 0"),
        activo: z.boolean().optional(),
        costo_produccion: z.coerce.number().min(0).optional(),
        proteccion_pct: z.coerce.number().min(0).optional(),
        ingredientes: z.array(ingrediente).min(1, "incluye al menos un ingrediente").optional(),
        // Preparación / subreceta: además de receta, se vuelve producto elaborado en inventario
        es_preparacion: z.boolean().optional(),
        rendimiento: z.coerce.number().positive("rendimiento debe ser > 0").optional(),
        unidad: z.string().trim().min(1, "unidad es requerida").optional(),
        stock_minimo: z.coerce.number().min(0).optional(),
    })
    .refine((d) => !d.es_preparacion || (d.rendimiento != null && d.unidad != null), {
        message: "Una preparación requiere 'rendimiento' y 'unidad'",
        path: ["rendimiento"],
    })
    .refine((d) => !d.es_preparacion || (Array.isArray(d.ingredientes) && d.ingredientes.length > 0), {
        message: "Una preparación requiere 'ingredientes' (su escandallo)",
        path: ["ingredientes"],
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
