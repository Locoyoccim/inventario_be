import { validate } from "../middlewares/validate.js";
import { requireAdmin, requirePermiso } from "../middlewares/auth.js";
import { finanzasController } from "../container.js";
import {
    categoriaGastoCreateSchema, categoriaGastoUpdateSchema,
    gastoCreateSchema, gastoUpdateSchema,
    ingresoCreateSchema, ingresoUpdateSchema,
    anularSchema,
} from "../modules/finanzas/finanzas.schema.js";

export default function registerFinanzas(router) {
    const b = "/finanzas/:empresa_id";

    // Categorías de gasto
    router.get(`${b}/categorias-gasto`, finanzasController.listarCategorias);
    router.post(`${b}/categorias-gasto`, requireAdmin, validate(categoriaGastoCreateSchema), finanzasController.crearCategoria);
    router.put(`${b}/categorias-gasto/:id`, requireAdmin, validate(categoriaGastoUpdateSchema), finanzasController.actualizarCategoria);

    // Gastos (crear: Admin y Operativo; editar/anular: Admin)
    router.get(`${b}/gastos`, finanzasController.listarGastos);
    router.post(`${b}/gastos`, requirePermiso("gastos.crear"), validate(gastoCreateSchema), finanzasController.crearGasto);
    router.post(`${b}/gastos/:id/anular`, requireAdmin, validate(anularSchema), finanzasController.anularGasto);
    router.put(`${b}/gastos/:id`, requireAdmin, validate(gastoUpdateSchema), finanzasController.actualizarGasto);

    // Ingresos (crear: Admin y Operativo; editar/anular: Admin)
    router.get(`${b}/ingresos`, finanzasController.listarIngresos);
    router.post(`${b}/ingresos/:id/anular`, requireAdmin, validate(anularSchema), finanzasController.anularIngreso);
    router.post(`${b}/ingresos`, requirePermiso("ingresos.crear"), validate(ingresoCreateSchema), finanzasController.crearIngreso);
    router.put(`${b}/ingresos/:id`, requireAdmin, validate(ingresoUpdateSchema), finanzasController.actualizarIngreso);

    // Libro y resumen (solo Admin)
    router.get(`${b}/movimientos`, requireAdmin, finanzasController.libro);
    router.get(`${b}/resumen`, requireAdmin, finanzasController.resumen);
}
