import { z } from "zod";
import { esFechaReal } from "../../utils/fecha.js";
import { canonizarUnidad, UNIDADES_CANONICAS } from "../../utils/unidades.js";

const unidadRecetaSchema = z
    .string()
    .trim()
    .min(1, "unidad es requerida")
    .transform((v, ctx) => {
        const u = canonizarUnidad(v);
        if (!u) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unidad no válida; usa una de: ${UNIDADES_CANONICAS.join(", ")}` });
            return z.NEVER;
        }
        return u;
    })
    .optional();

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
        unidad: unidadRecetaSchema,
        stock_minimo: z.coerce.number().min(0).optional(),
        iva_pct: z.coerce.number().min(0).max(100).optional(),
        precio_incluye_iva: z.boolean().optional(),
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
    // Opcional: si viene, REEMPLAZA el escandallo completo en la misma transacción
    // que el encabezado (guardado atómico). Si no viene, el escandallo no se toca.
    ingredientes: z.array(ingrediente).min(1, "incluye al menos un ingrediente").optional(),
    iva_pct: z.coerce.number().min(0).max(100).optional(),
    precio_incluye_iva: z.boolean().optional(),
});

export const recetaPreviewSchema = z.object({
    precio_venta: z.coerce.number().min(0).optional(),
    costo_produccion: z.coerce.number().min(0).optional(),
    proteccion_pct: z.coerce.number().min(0).optional(),
    ingredientes: z.array(ingrediente).min(1, "incluye al menos un ingrediente"),
});

// Query de GET /recetas/:e/ventas — mismas reglas y mensajes que finanzas/resumen.
export const ventasRecetaQuerySchema = z
    .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fechas inválidas (YYYY-MM-DD)").refine(esFechaReal, "fechas inválidas (YYYY-MM-DD)"),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fechas inválidas (YYYY-MM-DD)").refine(esFechaReal, "fechas inválidas (YYYY-MM-DD)"),
    })
    .refine((d) => d.desde <= d.hasta, { message: "desde debe ser <= hasta", path: ["desde"] })
    .refine((d) => (Date.parse(d.hasta) - Date.parse(d.desde)) / 86400000 + 1 <= 366, {
        message: "El rango máximo es 366 días",
        path: ["hasta"],
    });
