import { rolController } from "../container.js";

export default function registerRoles(router) {
    // Catálogo global de roles; se cuelga de :empresa_id solo por convención de ruta
    // (empresaGuard ya exige sesión válida de esa empresa).
    router.get("/roles/:empresa_id", rolController.listar);
}
