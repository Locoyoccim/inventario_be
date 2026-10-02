import { z } from "zod";

// Captura manual (POST /productos/:empresa_id/:id/movimientos): solo tipos pensados para
// corrección directa. COMPRA/VENTA/PRODUCCION tienen su propio módulo (Compras, Ventas,
// Producción) que además actualiza costo, propaga a recetas y deja su propio documento — un
// movimiento de ese tipo creado aquí quedaría "huérfano" y dejaría el costeo desincronizado.
export const movimientoCreateSchema = z.object({
    tipo_movimiento: z.enum(["MERMA", "AJUSTE", "DEVOLUCION"]),
    cantidad: z.coerce.number().refine((n) => n !== 0, "cantidad debe ser distinta de 0"),
    motivo: z.string().optional(),
    usuario_id: z.coerce.number().int().positive().optional(),
    costo_unitario: z.coerce.number().min(0).optional(),
});
