import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class InventarioController {
    constructor(inventarioService) {
        this.inventarioService = inventarioService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.inventarioService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: await this.inventarioService.getAllInventario(empresa_id) });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const inventario = await this.inventarioService.getInventarioById(id, empresa_id);
        if (!inventario) throw ApiError.notFound("Inventario no encontrado");
        res.json({ success: true, data: inventario });
    });
}
