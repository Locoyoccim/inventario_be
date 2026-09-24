import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";

export default class CompraController {
    constructor(compraService) {
        this.compraService = compraService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.compraService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const { limit, offset } = parsePagination(req.query);
        const { rows, total } = await this.compraService.getAll(empresa_id, { limit, offset });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.compraService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const compra = await this.compraService.getById(empresa_id, id);
        if (!compra) throw ApiError.notFound("Compra no encontrada");
        res.json({ success: true, data: compra });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.compraService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const usuario_id = req.user?.id ?? null;
        const data = await this.compraService.crear(empresa_id, { ...req.body, usuario_id });
        res.status(201).json({ success: true, data });
    });

    anular = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.compraService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const data = await this.compraService.anular(empresa_id, id, req.user?.id ?? null, req.body.motivo);
        res.json({ success: true, data });
    });
}
