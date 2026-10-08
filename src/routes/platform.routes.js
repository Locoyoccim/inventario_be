import { validate } from "../middlewares/validate.js";
import { requirePlatformAdmin } from "../middlewares/auth.js";
import { platformController } from "../container.js";
import { crearEmpresaSchema, cambiarEstadoEmpresaSchema, resetearPasswordOwnerSchema } from "../modules/platform/platform.schema.js";

// Administración de tenants: solo el usuario maestro de plataforma (is_platform_admin).
// No usa :empresa_id (el guard empresaGuard compararía contra la empresa del propio maestro,
// que no es la empresa que se está administrando), por eso vive en /platform/empresas y no
// bajo /empresas/:empresa_id.
export default function registerPlatform(router) {
    router.get("/platform/empresas", requirePlatformAdmin, platformController.listarEmpresas);
    router.post("/platform/empresas", requirePlatformAdmin, validate(crearEmpresaSchema), platformController.crearEmpresa);
    router.patch("/platform/empresas/:id/estado", requirePlatformAdmin, validate(cambiarEstadoEmpresaSchema), platformController.cambiarEstado);
    router.post("/platform/empresas/:id/reenviar-invitacion", requirePlatformAdmin, platformController.reenviarInvitacion);
    router.post("/platform/empresas/:id/resetear-password", requirePlatformAdmin, validate(resetearPasswordOwnerSchema), platformController.resetearPasswordOwner);
}
