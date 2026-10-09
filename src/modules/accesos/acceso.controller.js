import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { listarAccesosSchema } from "./acceso.schema.js";

const entero = (valor, nombre) => {
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw ApiError.badRequest(`${nombre} inválido`);
    return n;
};

export default class AccesoController {
    constructor(accesoService) {
        this.accesoService = accesoService;
    }

    listar = asyncHandler(async (req, res) => {
        const filtros = listarAccesosSchema.parse(req.query);
        res.json({ success: true, data: await this.accesoService.listar(filtros) });
    });

    conceder = asyncHandler(async (req, res) => {
        const data = await this.accesoService.conceder(
            req.user,
            entero(req.params.id, "usuario"),
            entero(req.params.destino, "empresa"),
            req.body,
        );
        res.json({ success: true, data });
    });

    retirar = asyncHandler(async (req, res) => {
        const data = await this.accesoService.retirar(
            entero(req.params.id, "usuario"),
            entero(req.params.destino, "empresa"),
        );
        res.json({ success: true, data });
    });

    // Owner de la empresa: DELETE /usuarios/:empresa_id/:id/acceso
    retirarComoOwner = asyncHandler(async (req, res) => {
        const data = await this.accesoService.retirarComoOwner(
            req.user,
            entero(req.params.empresa_id, "empresa"),
            entero(req.params.id, "usuario"),
        );
        res.json({ success: true, data });
    });
}
