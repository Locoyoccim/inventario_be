import { z } from "zod";
import { esFechaReal, noFutura } from "../../utils/fecha.js";

export const METODOS = ["EFECTIVO", "TARJETA", "TRANSFERENCIA", "OTRO"];

const fechaSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha debe tener formato YYYY-MM-DD")
    .refine(esFechaReal, "fecha inexistente (revisa día/mes)")
    .refine(noFutura, "la fecha no puede ser futura");

const montoSchema = z.coerce
    .number()
    .gt(0, "monto debe ser > 0")
    .refine((v) => Number.isFinite(v) && Math.abs(v - Math.round(v * 100) / 100) < 1e-9, "monto admite máximo 2 decimales");

const metodoSchema = z.enum(METODOS);

export const categoriaGastoCreateSchema = z.object({
    nombre: z.string().trim().min(1, "nombre es requerido").max(60),
});
export const categoriaGastoUpdateSchema = z.object({
    nombre: z.string().trim().min(1).max(60).optional(),
    activo: z.boolean().optional(),
});

export const gastoCreateSchema = z.object({
    fecha: fechaSchema,
    categoria_id: z.coerce.number().int().positive("categoria_id es requerido"),
    concepto: z.string().trim().min(1, "concepto es requerido").max(150),
    monto: montoSchema,
    metodo_pago: metodoSchema,
    proveedor_id: z.coerce.number().int().positive().optional(),
    nota: z.string().trim().optional(),
});
export const gastoUpdateSchema = gastoCreateSchema;

export const ingresoCreateSchema = z.object({
    fecha: fechaSchema,
    metodo_pago: metodoSchema,
    monto: montoSchema,
    concepto: z.string().trim().min(1).max(150).optional(),
    nota: z.string().trim().optional(),
});
export const ingresoUpdateSchema = ingresoCreateSchema;

export const ingresoLoteSchema = z.object({
    fecha: fechaSchema,
    lineas: z.array(z.object({ metodo_pago: metodoSchema, monto: montoSchema })).min(1, "envía al menos una línea"),
});

export const anularSchema = z.object({
    motivo: z.string().trim().min(1, "motivo es requerido"),
});
