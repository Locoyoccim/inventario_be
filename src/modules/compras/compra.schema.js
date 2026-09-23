import { z } from "zod";

const lineaCompra = z
    .object({
        producto_id: z.coerce.number().int().positive(),
        cantidad: z.coerce.number().positive("cantidad debe ser > 0"),
        costo_total: z.coerce.number().min(0).optional(),
        costo_unitario: z.coerce.number().min(0).optional(),
    })
    .refine((l) => l.costo_total != null || l.costo_unitario != null, {
        message: "Cada línea requiere 'costo_total' (lo pagado) o 'costo_unitario'",
        path: ["costo_total"],
    });

export const compraCreateSchema = z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD").optional(),
    proveedor_id: z.coerce.number().int().positive().optional(),
    referencia: z.string().trim().optional(),
    lineas: z.array(lineaCompra).min(1, "incluye al menos una línea de compra"),
});
