import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { recetaController, recetaDetalleController } from "../container.js";
import { recetaCreateSchema, recetaUpdateSchema, recetaPreviewSchema } from "../modules/recetas/receta.schema.js";
import { recetaDetalleSchema } from "../modules/recetaDetalle/recetaDetalle.schema.js";

export default function registerRecetas(router) {
    // ORDEN: las rutas de /detalle (segmentos literales) van ANTES que las genéricas
    // /recetas/:empresa_id/:id para que Express no las capture como :id.
    router.get("/recetas/:receta_id/detalle", recetaDetalleController.listar);
    router.get("/recetas/:receta_id/detalle/:id", recetaDetalleController.listarPorId);
    router.post("/recetas/:receta_id/detalle", requireAdmin, validate(recetaDetalleSchema), recetaDetalleController.crear);
    router.put("/recetas/:receta_id/detalle/:id", requireAdmin, validate(recetaDetalleSchema), recetaDetalleController.actualizar);
    router.delete("/recetas/:receta_id/detalle/:id", requireAdmin, recetaDetalleController.eliminar);

    router.post("/recetas/:empresa_id/preview", validate(recetaPreviewSchema), recetaController.preview);
    router.get("/recetas/:empresa_id", recetaController.listar);
    router.get("/recetas/:empresa_id/:id", recetaController.listarPorId);
    router.post("/recetas/:empresa_id", requireAdmin, validate(recetaCreateSchema), recetaController.crear);
    router.put("/recetas/:empresa_id/:id", requireAdmin, validate(recetaUpdateSchema), recetaController.actualizar);
    router.delete("/recetas/:empresa_id/:id", requireAdmin, recetaController.eliminar);
}
