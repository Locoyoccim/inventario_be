import { asyncHandler } from "../../middlewares/asyncHandler.js";

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Catálogo de opciones por producto (solo Admin). La lectura para tomar órdenes viaja dentro de GET /menu.
export default class PosOpcionesController {
    constructor(opciones) {
        this.opciones = opciones;
    }

    listar = asyncHandler(async (req, res) => ok(res, await this.opciones.listar(req.params.empresa_id)));
    crear = asyncHandler(async (req, res) => ok(res, await this.opciones.crear(req.params.empresa_id, req.body), 201));
    actualizar = asyncHandler(async (req, res) => ok(res, await this.opciones.actualizar(req.params.empresa_id, req.params.id, req.body)));
    desactivar = asyncHandler(async (req, res) => ok(res, await this.opciones.desactivar(req.params.empresa_id, req.params.id)));
}
