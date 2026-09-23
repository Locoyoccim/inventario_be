import { z } from "zod";
export const categoriaSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido").max(50, "máximo 50 caracteres"),
});
