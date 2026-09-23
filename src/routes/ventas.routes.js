import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { ventaController } from "../container.js";
import { ventaImportSchema } from "../modules/ventas/venta.schema.js";

export default function registerVentas(router) {
    router.post("/ventas/:empresa_id/importar", validate(ventaImportSchema), ventaController.importar);
    router.get("/ventas/:empresa_id/:fecha", ventaController.consultarDia);
    router.delete("/ventas/:empresa_id/:fecha", requireAdmin, ventaController.revertirDia);
}
