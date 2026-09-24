import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { ventaController } from "../container.js";
import { ventaImportSchema, ventaPreviewSchema } from "../modules/ventas/venta.schema.js";

export default function registerVentas(router) {
    router.get("/ventas/:empresa_id", ventaController.listarDias);
    router.post("/ventas/:empresa_id/importar", validate(ventaImportSchema), ventaController.importar);
    router.post("/ventas/:empresa_id/preview", validate(ventaPreviewSchema), ventaController.previsualizar);
    router.get("/ventas/:empresa_id/:fecha", ventaController.consultarDia);
    router.delete("/ventas/:empresa_id/:fecha", requireAdmin, ventaController.revertirDia);
}
