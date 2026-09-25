import { z } from "zod";

const TIPOS = ["PRODUCTO", "RECETA", "AMBAS"];

export const categoriaCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido").max(50, "máximo 50 caracteres"),
    tipo: z.enum(TIPOS).optional(),
});

// PUT: nombre y/o tipo (al menos uno). Si nombre no viene, se conserva; igual el tipo.
export const categoriaUpdateSchema = z
    .object({
        nombre: z.string().trim().min(1, "nombre es requerido").max(50, "máximo 50 caracteres").optional(),
        tipo: z.enum(TIPOS).optional(),
    })
    .refine((d) => d.nombre !== undefined || d.tipo !== undefined, {
        message: "Envía 'nombre' y/o 'tipo'",
    });
