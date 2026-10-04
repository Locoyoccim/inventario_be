import { validate } from "../middlewares/validate.js";
import { requireOwnerOrAdmin } from "../middlewares/auth.js";
import { empresaSelfGuard } from "../middlewares/scopeGuards.js";
import { empresaController } from "../container.js";
import { empresaConfigSchema } from "../modules/empresas/empresa.schema.js";

// El alta, baja y datos generales de las empresas son del usuario maestro de plataforma (/platform/empresas).
// Aquí cada empresa solo consulta y ajusta su propia configuración.
export default function registerEmpresas(router) {
    router.get("/empresas/:id/configuracion", empresaSelfGuard, empresaController.getConfiguracion);
    router.put("/empresas/:id/configuracion", empresaSelfGuard, requireOwnerOrAdmin, validate(empresaConfigSchema), empresaController.actualizarConfiguracion);
}
