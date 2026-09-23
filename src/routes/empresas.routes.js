import { validate } from "../middlewares/validate.js";
import { requireOwnerOrAdmin } from "../middlewares/auth.js";
import { empresaSelfGuard } from "../middlewares/scopeGuards.js";
import { empresaController } from "../container.js";
import { empresaCreateSchema, empresaUpdateSchema } from "../modules/empresas/empresa.schema.js";

export default function registerEmpresas(router) {
    router.get("/empresas/", empresaController.listar);
    router.get("/empresas/:id", empresaSelfGuard, empresaController.listarPorId);
    router.post("/empresas/", requireOwnerOrAdmin, validate(empresaCreateSchema), empresaController.crearEmpresa);
    router.put("/empresas/:id", empresaSelfGuard, requireOwnerOrAdmin, validate(empresaUpdateSchema), empresaController.actualizarEmpresa);
    router.delete("/empresas/:id", empresaSelfGuard, requireOwnerOrAdmin, empresaController.eliminarEmpresa);
}
