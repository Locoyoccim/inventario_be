import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { produccionController } from "../container.js";
import { produccionConfirmarSchema, produccionAnularSchema } from "../modules/produccion/produccion.schema.js";

// Confirmar produccion: Operativo y Admin (consume insumos y suma la preparacion).
// Anular: solo Admin, igual que compras/conteos.
export default function registerProduccion(router) {
    router.get("/produccion/:empresa_id/sugerencias", produccionController.sugerencias);
    router.get("/produccion/:empresa_id", produccionController.listar);
    router.get("/produccion/:empresa_id/:id", produccionController.listarPorId);
    router.post("/produccion/:empresa_id/confirmar", validate(produccionConfirmarSchema), produccionController.confirmar);
    router.post("/produccion/:empresa_id/:id/anular", requireAdmin, validate(produccionAnularSchema), produccionController.anular);
}
