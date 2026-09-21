import { z } from "zod";

export const movimientoCreateSchema = z.object({
    tipo_movimiento: z.enum(["COMPRA", "VENTA", "MERMA", "AJUSTE", "DEVOLUCION", "PRODUCCION"]),
    cantidad: z.coerce.number().refine((n) => n !== 0, "cantidad debe ser distinta de 0"),
    motivo: z.string().optional(),
    usuario_id: z.coerce.number().int().positive().optional(),
    costo_unitario: z.coerce.number().min(0).optional(),
    referencia_tipo: z.string().optional(),
    referencia_id: z.coerce.number().int().optional(),
});
