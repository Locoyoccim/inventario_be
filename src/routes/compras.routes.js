import { validate } from "../middlewares/validate.js";
import { requireAdmin, requirePermiso } from "../middlewares/auth.js";
import { compraController } from "../container.js";
import { compraCreateSchema, compraAnularSchema, compraPedidoCreateSchema, compraRecibirSchema } from "../modules/compras/compra.schema.js";

export default function registerCompras(router) {
    router.get("/compras/:empresa_id", compraController.listar);
    router.get("/compras/:empresa_id/:id", compraController.listarPorId);
    router.post("/compras/:empresa_id", requirePermiso("compras.crear"), validate(compraCreateSchema), compraController.crear);
    router.post("/compras/:empresa_id/pedido", requirePermiso("compras.crear"), validate(compraPedidoCreateSchema), compraController.crearPedido);
    router.post("/compras/:empresa_id/:id/recibir", requirePermiso("compras.crear"), validate(compraRecibirSchema), compraController.recibir);
    router.post("/compras/:empresa_id/:id/anular", requireAdmin, validate(compraAnularSchema), compraController.anular);
}
