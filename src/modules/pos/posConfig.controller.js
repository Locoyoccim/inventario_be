import { asyncHandler } from "../../middlewares/asyncHandler.js";

const bool = (v) => v === "true" || v === "1";

export default class PosConfigController {
    constructor(posConfigService) {
        this.service = posConfigService;
    }

    listarAreas = asyncHandler(async (req, res) => {
        res.json({ success: true, data: await this.service.listarAreas(req.params.empresa_id) });
    });
    crearArea = asyncHandler(async (req, res) => {
        res.status(201).json({ success: true, data: await this.service.crearArea(req.params.empresa_id, req.body) });
    });
    actualizarArea = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.service.actualizarArea(empresa_id, id, req.body) });
    });

    listarMesas = asyncHandler(async (req, res) => {
        res.json({ success: true, data: await this.service.listarMesas(req.params.empresa_id, bool(req.query.incluir_inactivas)) });
    });
    crearMesa = asyncHandler(async (req, res) => {
        res.status(201).json({ success: true, data: await this.service.crearMesa(req.params.empresa_id, req.body) });
    });
    actualizarMesa = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.service.actualizarMesa(empresa_id, id, req.body) });
    });

    listarAsignacion = asyncHandler(async (req, res) => {
        res.json({ success: true, data: await this.service.listarAsignacion(req.params.empresa_id) });
    });
    asignarAreaCategoria = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.service.asignarAreaCategoria(empresa_id, id, req.body.area_id) });
    });
    asignarAreaArticulo = asyncHandler(async (req, res) => {
        const { empresa_id, tipo, id } = req.params;
        res.json({ success: true, data: await this.service.asignarAreaArticulo(empresa_id, String(tipo).toUpperCase(), id, req.body.area_id) });
    });

    menu = asyncHandler(async (req, res) => {
        res.json({ success: true, data: await this.service.menu(req.params.empresa_id) });
    });
}
