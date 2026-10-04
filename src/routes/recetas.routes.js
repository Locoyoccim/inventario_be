import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { recetaController } from "../container.js";
import { recetaCreateSchema, recetaUpdateSchema, recetaPreviewSchema } from "../modules/recetas/receta.schema.js";

export default function registerRecetas(router) {
    // Ingredientes de una receta (lo usan el detalle y la edición). Va ANTES de /recetas/:empresa_id/:id para que
    // Express no capture "detalle" como :id. El guard de :receta_id valida que la receta sea de la empresa del token.
    router.get("/recetas/:receta_id/detalle", recetaController.detalle);
    router.post("/recetas/:empresa_id/preview", validate(recetaPreviewSchema), recetaController.preview);
    router.get("/recetas/:empresa_id/ventas", requireAdmin, recetaController.ventasPorReceta);
    router.get("/recetas/:empresa_id", recetaController.listar);
    router.get("/recetas/:empresa_id/:id", recetaController.listarPorId);
    router.post("/recetas/:empresa_id", requireAdmin, validate(recetaCreateSchema), recetaController.crear);
    router.put("/recetas/:empresa_id/:id", requireAdmin, validate(recetaUpdateSchema), recetaController.actualizar);
    router.delete("/recetas/:empresa_id/:id", requireAdmin, recetaController.eliminar);
}
