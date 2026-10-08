import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { pinController } from "../container.js";
import { definirPinSchema, dispositivoSchema } from "../modules/auth/pin.schema.js";

// Equipos registrados y PIN del personal: solo Admin (y nunca desde una sesión de PIN, ver requireAdmin).
export default function registerDispositivos(router) {
    router.get("/dispositivos/:empresa_id", requireAdmin, pinController.listarEquipos);
    router.post("/dispositivos/:empresa_id", requireAdmin, validate(dispositivoSchema), pinController.crearEquipo);
    router.put("/dispositivos/:empresa_id/:id", requireAdmin, validate(dispositivoSchema), pinController.renombrarEquipo);
    router.post("/dispositivos/:empresa_id/:id/codigo", requireAdmin, pinController.codigoNuevo);
    router.post("/dispositivos/:empresa_id/:id/revocar", requireAdmin, pinController.revocarEquipo);
    router.put("/usuarios/:empresa_id/:id/pin", requireAdmin, validate(definirPinSchema), pinController.definirPin);
    router.delete("/usuarios/:empresa_id/:id/pin", requireAdmin, pinController.quitarPin);
    router.post("/usuarios/:empresa_id/:id/pin/desbloquear", requireAdmin, pinController.desbloquearPin);
}
