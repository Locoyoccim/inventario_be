import { validate } from "../middlewares/validate.js";
import { requireAdmin, requirePermiso } from "../middlewares/auth.js";
import { produccionController } from "../container.js";
import { produccionConfirmarSchema, produccionAnularSchema } from "../modules/produccion/produccion.schema.js";

// Confirmar produccion: Operativo (con permiso produccion.crear) y Admin.
// Anular: solo Admin, igual que compras/conteos.
export default function registerProduccion(router) {
    router.get("/produccion/:empresa_id/sugerencias", produccionController.sugerencias);
    // Antes de /produccion/:empresa_id/:id para que "plan" no se capture como :id.
    router.get("/produccion/:empresa_id/plan/:receta_id", produccionController.planificar);
    router.get("/produccion/:empresa_id", produccionController.listar);
    router.get("/produccion/:empresa_id/:id", produccionController.listarPorId);
    router.post("/produccion/:empresa_id/confirmar", requirePermiso("produccion.crear"), validate(produccionConfirmarSchema), produccionController.confirmar);
    router.post("/produccion/:empresa_id/:id/anular", requireAdmin, validate(produccionAnularSchema), produccionController.anular);
}
