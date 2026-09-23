import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class ProduccionController {
    constructor(produccionService) {
        this.produccionService = produccionService;
    }

    sugerencias = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const data = await this.produccionService.getSugerencias(empresa_id);
        res.json({ success: true, data });
    });

    confirmar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const usuario_id = req.user?.id ?? null;
        const data = await this.produccionService.confirmar(empresa_id, req.body.producciones, usuario_id);
        res.status(201).json({ success: true, data });
    });
}
