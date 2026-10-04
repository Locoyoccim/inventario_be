import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { posController } from "../container.js";
import { resultadoImpresionSchema } from "../modules/pos/pos.schema.js";

// Rutas del agente de impresión (PC de caja). Se montan ANTES de la cadena de usuario: se
// autentican con el token propio del agente, no con la sesión de un usuario.
const router = Router();
router.use(posController.requireAgente);
router.get("/impresiones/pendientes", posController.agentePendientes);
router.post("/impresiones/:id/resultado", validate(resultadoImpresionSchema), posController.agenteResultado);

export default router;
