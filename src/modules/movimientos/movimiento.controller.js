import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";

export default class MovimientoController {
    constructor(movimientoService) {
        this.movimientoService = movimientoService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const { rows, total } = await this.movimientoService.getMovimientos(id, empresa_id, { limit, offset });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const movimiento = await this.movimientoService.registrarMovimiento(id, empresa_id, req.body);
        if (!movimiento) throw ApiError.notFound("Producto no encontrado");
        res.status(201).json({ success: true, data: movimiento });
    });
}
