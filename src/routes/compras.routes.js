import { validate } from "../middlewares/validate.js";
import { compraController } from "../container.js";
import { compraCreateSchema } from "../modules/compras/compra.schema.js";

export default function registerCompras(router) {
    router.get("/compras/:empresa_id", compraController.listar);
    router.get("/compras/:empresa_id/:id", compraController.listarPorId);
    router.post("/compras/:empresa_id", validate(compraCreateSchema), compraController.crear);
}
