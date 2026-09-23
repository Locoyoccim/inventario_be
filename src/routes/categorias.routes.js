import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { categoriaController } from "../container.js";
import { categoriaSchema } from "../modules/categorias/categoria.schema.js";

export default function registerCategorias(router) {
    router.get("/categorias/:empresa_id", categoriaController.listar);
    router.post("/categorias/:empresa_id", requireAdmin, validate(categoriaSchema), categoriaController.crear);
    router.put("/categorias/:empresa_id/:id", requireAdmin, validate(categoriaSchema), categoriaController.actualizar);
    router.delete("/categorias/:empresa_id/:id", requireAdmin, categoriaController.eliminar);
}
