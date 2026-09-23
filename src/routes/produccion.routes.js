import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { produccionController } from "../container.js";
import { produccionConfirmarSchema } from "../modules/produccion/produccion.schema.js";

export default function registerProduccion(router) {
    router.get("/produccion/:empresa_id/sugerencias", produccionController.sugerencias);
    router.post("/produccion/:empresa_id/confirmar", requireAdmin, validate(produccionConfirmarSchema), produccionController.confirmar);
}
