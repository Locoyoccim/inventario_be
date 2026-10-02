import { validate } from "../middlewares/validate.js";
import { requirePermiso } from "../middlewares/auth.js";
import { reservacionController } from "../container.js";
import {
    reservacionCreateSchema, reservacionUpdateSchema, reservacionEstadoSchema,
} from "../modules/reservaciones/reservaciones.schema.js";

export default function registerReservaciones(router) {
    const b = "/reservaciones/:empresa_id";
    const permiso = requirePermiso("reservaciones.gestionar");

    router.get(b, permiso, reservacionController.listar);
    router.post(b, permiso, validate(reservacionCreateSchema), reservacionController.crear);
    router.put(`${b}/:id`, permiso, validate(reservacionUpdateSchema), reservacionController.actualizar);
    router.put(`${b}/:id/estado`, permiso, validate(reservacionEstadoSchema), reservacionController.cambiarEstado);
    router.delete(`${b}/:id`, permiso, reservacionController.eliminar);
}
