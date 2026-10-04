import { z } from "zod";

// Crea una empresa nueva junto con su primer Owner, en una sola transacción. Sustituye a
// /auth/setup (que solo funciona una vez, para el primer usuario de toda la base).
export const crearEmpresaSchema = z.object({
    empresa: z.object({
        nombre: z.string().trim().min(1, "nombre de la empresa es requerido"),
        titular: z.string().trim().optional(),
        telefono: z.string().trim().optional(),
        email: z.string().trim().optional(),
        domicilio: z.string().trim().optional(),
    }),
    owner: z.object({
        nombre: z.string().trim().min(1, "nombre del owner es requerido"),
        email: z.string().trim().toLowerCase().email("email inválido"),
        // Opcional: sin contraseña el owner recibe un enlace por correo para definir la suya (recomendado).
        password: z.string().min(8, "password debe tener al menos 8 caracteres").optional(),
        codigo_ingreso: z.string().trim().min(1, "codigo_ingreso es requerido"),
        puesto: z.string().trim().optional(),
    }),
});

export const cambiarEstadoEmpresaSchema = z.object({
    activo: z.boolean(),
});

export const resetearPasswordOwnerSchema = z.object({
    password: z.string().min(8, "password debe tener al menos 8 caracteres"),
});
