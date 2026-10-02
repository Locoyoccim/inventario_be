import { z } from "zod";
import { esFechaReal } from "../../utils/fecha.js";

export const ESTADOS = ["pendiente", "confirmada", "sentada", "no_show", "cancelada"];

const fechaSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD")
    .refine(esFechaReal, "fecha inexistente (revisa día/mes)");

const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "hora debe tener formato HH:MM");

export const reservacionCreateSchema = z.object({
    nombre_cliente: z.string().trim().min(1, "nombre es requerido").max(120),
    telefono_cliente: z.string().trim().min(1, "teléfono es requerido").max(30),
    fecha: fechaSchema,
    hora: horaSchema,
    personas: z.coerce.number().int().positive("personas debe ser mayor a 0"),
    alergias: z.string().trim().max(500).optional(),
    comentarios: z.string().trim().max(500).optional(),
});

export const reservacionUpdateSchema = reservacionCreateSchema;

export const reservacionEstadoSchema = z.object({
    estado: z.enum(ESTADOS),
});
