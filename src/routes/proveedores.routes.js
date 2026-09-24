import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { proveedorController } from "../container.js";
import { proveedorCreateSchema, proveedorUpdateSchema, fusionarSchema } from "../modules/proveedores/proveedor.schema.js";

export default function registerProveedores(router) {
    router.get("/proveedores/:empresa_id", proveedorController.listar);
    router.get("/proveedores/:empresa_id/:id", proveedorController.listarPorId);
    router.post("/proveedores/:empresa_id", requireAdmin, validate(proveedorCreateSchema), proveedorController.crear);
    router.put("/proveedores/:empresa_id/:id", requireAdmin, validate(proveedorUpdateSchema), proveedorController.actualizar);
    router.get("/proveedores/:empresa_id/:id/resumen", proveedorController.resumen);
    router.post("/proveedores/:empresa_id/:id/fusionar", requireAdmin, validate(fusionarSchema), proveedorController.fusionar);
    router.delete("/proveedores/:empresa_id/:id", requireAdmin, proveedorController.eliminar);
}
