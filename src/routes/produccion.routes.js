import { validate } from "../middlewares/validate.js";
import { produccionController } from "../container.js";
import { produccionConfirmarSchema } from "../modules/produccion/produccion.schema.js";

// Confirmar produccion: Operativo y Admin (consume insumos y suma la preparacion).
export default function registerProduccion(router) {
    router.get("/produccion/:empresa_id/sugerencias", produccionController.sugerencias);
    router.post("/produccion/:empresa_id/confirmar", validate(produccionConfirmarSchema), produccionController.confirmar);
}
