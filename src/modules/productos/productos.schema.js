import { z } from "zod";

export const productoCreateSchema = z.object({
    producto: z.string().trim().min(1, "producto es requerido"),
    unidad_medida: z.string().trim().min(1, "unidad_medida es requerida"),
    proveedor_id: z.coerce.number().int().positive("proveedor_id es requerido"),
    categoria: z.string().trim().min(1, "categoria es requerida"),
    cantidad_presentacion: z.coerce.number().positive("cantidad_presentacion debe ser > 0"),
    costo_presentacion: z.coerce.number().min(0, "costo_presentacion debe ser >= 0"),
    stock_actual: z.coerce.number().min(0, "stock_actual debe ser >= 0"),
    stock_minimo: z.coerce.number().min(0, "stock_minimo debe ser >= 0"),
});

// Mismos campos para actualizar
// En update, stock_actual NO se acepta: el stock se ajusta por /movimientos (GAP-06)
export const productoUpdateSchema = productoCreateSchema.omit({ stock_actual: true });
