import { asyncHandler } from "../../middlewares/asyncHandler.js";

export default class PlatformController {
    constructor(platformService) {
        this.platformService = platformService;
    }

    listarEmpresas = asyncHandler(async (req, res) => {
        const data = await this.platformService.listarEmpresas();
        res.json({ success: true, data });
    });

    crearEmpresa = asyncHandler(async (req, res) => {
        const data = await this.platformService.crearEmpresa(req.body);
        res.status(201).json({ success: true, data });
    });

    cambiarEstado = asyncHandler(async (req, res) => {
        const data = await this.platformService.cambiarEstado(req.params.id, req.body.activo);
        res.json({ success: true, data });
    });

    resetearPasswordOwner = asyncHandler(async (req, res) => {
        const data = await this.platformService.resetearPasswordOwner(req.params.id, req.body.password);
        res.json({ success: true, data });
    });
}
