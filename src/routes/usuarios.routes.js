import { validate } from "../middlewares/validate.js";
import { requireAdmin } from "../middlewares/auth.js";
import { usuarioController } from "../container.js";
import { usuarioCreateSchema, usuarioUpdateSchema } from "../modules/usuarios/usuario.schema.js";

export default function registerUsuarios(router) {
    router.get("/usuarios/:empresa_id", usuarioController.listar);
    router.get("/usuarios/:empresa_id/:id", usuarioController.listarPorId);
    router.post("/usuarios/:empresa_id", requireAdmin, validate(usuarioCreateSchema), usuarioController.crear);
    router.put("/usuarios/:empresa_id/:id", requireAdmin, validate(usuarioUpdateSchema), usuarioController.actualizar);
    router.delete("/usuarios/:empresa_id/:id", requireAdmin, usuarioController.eliminar);
}
