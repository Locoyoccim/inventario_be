import { z } from "zod";
import { canonizarUnidad, UNIDADES_CANONICAS } from "../../utils/unidades.js";

// Valida y normaliza la unidad de medida a su forma canónica (g, kg, ml, l, pieza, porcion).
const unidadMedidaSchema = z
    .string()
    .trim()
    .min(1, "unidad_medida es requerida")
    .transform((v, ctx) => {
        const u = canonizarUnidad(v);
        if (!u) {
            ctx.addIssue({ code: "custom", message: `unidad no válida; usa una de: ${UNIDADES_CANONICAS.join(", ")}` });
            return z.NEVER;
        }
        return u;
    });

const productoBaseSchema = z.object({
    producto: z.string().trim().min(1, "producto es requerido"),
    unidad_medida: unidadMedidaSchema,
    proveedor_id: z.coerce.number().int().positive("proveedor_id es requerido"),
    categoria: z.string().trim().min(1, "categoria es requerida"),
    cantidad_presentacion: z.coerce.number().positive("cantidad_presentacion debe ser > 0"),
    costo_presentacion: z.coerce.number().min(0, "costo_presentacion debe ser >= 0"),
    stock_actual: z.coerce.number().min(0, "stock_actual debe ser >= 0"),
    stock_minimo: z.coerce.number().min(0, "stock_minimo debe ser >= 0"),
    // Opcional: sin maximo, "Por pedir" sigue sugiriendo solo hasta el minimo (comportamiento actual).
    stock_maximo: z.coerce.number().min(0, "stock_maximo debe ser >= 0").optional(),
    compra_al_producir: z.boolean().optional(),
    merma_pct: z.coerce.number().min(0, "merma_pct debe ser >= 0").max(89.99, "merma_pct debe ser < 90").optional(),
    // Solo para productos que se venden tal cual (mapeados INSUMO en el POS), sin receta.
    // Habilita el "ingreso esperado" de Finanzas para esas ventas.
    precio_venta: z.coerce.number().min(0, "precio_venta debe ser >= 0").optional(),
});

// Si se captura maximo, debe superar al minimo; si no, "hasta donde pedir" no tendria sentido.
function validarMaximo(data, ctx) {
    if (data.stock_maximo !== undefined && data.stock_maximo <= data.stock_minimo) {
        ctx.addIssue({ code: "custom", message: "stock_maximo debe ser mayor que stock_minimo", path: ["stock_maximo"] });
    }
}

export const productoCreateSchema = productoBaseSchema.superRefine(validarMaximo);

// Mismos campos para actualizar
// En update, stock_actual NO se acepta: el stock se ajusta por /movimientos (GAP-06)
export const productoUpdateSchema = productoBaseSchema
    .omit({ stock_actual: true })
    .extend({ activo: z.boolean().optional() })
    .superRefine(validarMaximo);

// Solo mínimo/máximo: para productos elaborados (preparaciones), cuyo resto de campos
// (unidad, presentación, costo) vienen de la receta y no se editan aquí.
export const productoLimitesSchema = z
    .object({
        stock_minimo: z.coerce.number().min(0, "stock_minimo debe ser >= 0"),
        stock_maximo: z.coerce.number().min(0, "stock_maximo debe ser >= 0").optional(),
    })
    .superRefine(validarMaximo);
