import { validate } from "../middlewares/validate.js";
import { requireAdmin, requireOwner } from "../middlewares/auth.js";
import { usuarioController, accesoController } from "../container.js";
import { usuarioCreateSchema, usuarioUpdateSchema } from "../modules/usuarios/usuario.schema.js";

export default function registerUsuarios(router) {
    router.get("/usuarios/:empresa_id", usuarioController.listar);
    router.post(
        "/usuarios/:empresa_id",
        requireAdmin,
        validate(usuarioCreateSchema),
        usuarioController.crear,
    );
    router.put(
        "/usuarios/:empresa_id/:id",
        requireAdmin,
        validate(usuarioUpdateSchema),
        usuarioController.actualizar,
    );
    // Retira el acceso compartido de una persona a ESTA empresa: solo el Owner (el maestro lo hace desde Plataforma).
    router.delete(
        "/usuarios/:empresa_id/:id/acceso",
        requireOwner,
        accesoController.retirarComoOwner,
    );
}
