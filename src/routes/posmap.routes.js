import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { posMapController } from "../container.js";
import { posMapItemSchema, posMapBulkSchema } from "../modules/posMap/posMap.schema.js";

export default function registerPosMap(router) {
    router.get("/pos-map/:empresa_id", posMapController.listar);
    router.get("/pos-map/:empresa_id/:id", posMapController.listarPorId);
    router.post("/pos-map/:empresa_id/bulk", requireAdmin, validate(posMapBulkSchema), posMapController.crearBulk);
    router.post("/pos-map/:empresa_id", requireAdmin, validate(posMapItemSchema), posMapController.crear);
    router.put("/pos-map/:empresa_id/:id", requireAdmin, validate(posMapItemSchema), posMapController.actualizar);
    router.delete("/pos-map/:empresa_id/:id", requireAdmin, posMapController.eliminar);
}
