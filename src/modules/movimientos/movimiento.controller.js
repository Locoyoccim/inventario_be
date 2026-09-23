import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";
import { parseFiltrosKardex } from "./movimiento.logic.js";

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

    // GET /movimientos/:empresa_id — kardex de la empresa con filtros.
    listarEmpresa = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const filtros = parseFiltrosKardex(req.query);
        const { rows, total } = await this.movimientoService.getKardex(empresa_id, { limit, offset, ...filtros });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        // El autor es quien hace la peticion (no lo que diga el body).
        const data = { ...req.body, usuario_id: req.user?.id ?? null };
        const movimiento = await this.movimientoService.registrarMovimiento(id, empresa_id, data);
        if (!movimiento) throw ApiError.notFound("Producto no encontrado");
        res.status(201).json({ success: true, data: movimiento });
    });
}
