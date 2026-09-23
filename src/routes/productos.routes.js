import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { productoController, movimientoController } from "../container.js";
import { productoCreateSchema, productoUpdateSchema } from "../modules/productos/productos.schema.js";
import { movimientoCreateSchema } from "../modules/movimientos/movimiento.schema.js";

export default function registerProductos(router) {
    router.get("/productos/:empresa_id", productoController.listar);
    router.get("/productos/:empresa_id/:id", productoController.listarPorId);
    router.post("/productos/:empresa_id/", requireAdmin, validate(productoCreateSchema), productoController.crearProducto);
    router.put("/productos/:empresa_id/:id", requireAdmin, validate(productoUpdateSchema), productoController.actualizarProducto);
    router.delete("/productos/:empresa_id/:id", requireAdmin, productoController.eliminarProducto);
    // Movimientos de inventario (cuelgan del producto)
    router.get("/productos/:empresa_id/:id/movimientos", movimientoController.listar);
    router.post("/productos/:empresa_id/:id/movimientos", requireAdmin, validate(movimientoCreateSchema), movimientoController.crear);
}
