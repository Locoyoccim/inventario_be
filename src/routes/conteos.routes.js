import { validate } from "../middlewares/validate.js";
import { conteoController } from "../container.js";
import { conteoCreateSchema } from "../modules/conteos/conteo.schema.js";

export default function registerConteos(router) {
    router.get("/conteos/:empresa_id/plantilla", conteoController.plantilla);
    router.get("/conteos/:empresa_id", conteoController.listar);
    router.get("/conteos/:empresa_id/:id", conteoController.listarPorId);
    router.post("/conteos/:empresa_id", validate(conteoCreateSchema), conteoController.crear);
}
