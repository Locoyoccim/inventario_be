import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { esFechaReal } from "../../utils/fecha.js";
import ApiError from "../../utils/ApiError.js";

function fechaQuery(v, campo) {
    if (v === undefined || v === null || v === "") return null;
    if (!esFechaReal(String(v))) throw ApiError.badRequest(`${campo} inválida (YYYY-MM-DD)`);
    return String(v);
}

export default class ReservacionController {
    constructor(reservacionService) {
        this.reservacionService = reservacionService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const filtros = {
            desde: fechaQuery(req.query.desde, "desde"),
            hasta: fechaQuery(req.query.hasta, "hasta"),
            estado: req.query.estado || null,
        };
        const data = await this.reservacionService.listar(empresa_id, filtros);
        res.json({ success: true, data });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const nueva = await this.reservacionService.crear(empresa_id, req.body, req.user.id);
        res.status(201).json({ success: true, data: nueva });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.reservacionService.actualizar(empresa_id, id, req.body) });
    });

    cambiarEstado = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.reservacionService.cambiarEstado(empresa_id, id, req.body.estado) });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        await this.reservacionService.eliminar(empresa_id, id);
        res.json({ success: true });
    });
}
