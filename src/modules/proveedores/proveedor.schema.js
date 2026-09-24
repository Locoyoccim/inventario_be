import { z } from "zod";
export const proveedorCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido"),
    telefono: z.string().trim().optional(),
    email: z.string().trim().optional(),
    domicilio: z.string().trim().optional(),
});
// En update se permite 'activo' para reactivar un proveedor desactivado.
export const proveedorUpdateSchema = proveedorCreateSchema.extend({
    activo: z.boolean().optional(),
});
