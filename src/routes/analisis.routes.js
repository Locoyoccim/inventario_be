import { requireAdmin } from "../middlewares/auth.js";
import { analisisController } from "../container.js";

// Análisis del negocio (solo Admin): ingeniería de menú, costo teórico contra real y control de fugas.
export default function registerAnalisis(router) {
    router.get("/analisis/:empresa_id/menu", requireAdmin, analisisController.menu);
    router.get("/analisis/:empresa_id/consumo", requireAdmin, analisisController.consumo);
    router.get("/analisis/:empresa_id/fugas", requireAdmin, analisisController.fugas);
}
