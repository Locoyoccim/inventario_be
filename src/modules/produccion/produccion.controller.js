import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";

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

    planificar = asyncHandler(async (req, res) => {
        const { empresa_id, receta_id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const lotes = Number(req.query.lotes ?? 1);
        const data = await this.produccionService.planificar(empresa_id, receta_id, lotes);
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

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const { limit, offset } = parsePagination(req.query);
        const { rows, total } = await this.produccionService.getAll(empresa_id, { limit, offset });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const produccion = await this.produccionService.getById(empresa_id, id);
        if (!produccion) throw ApiError.notFound("Producción no encontrada");
        res.json({ success: true, data: produccion });
    });

    anular = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.produccionService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const data = await this.produccionService.anular(empresa_id, id, req.user?.id ?? null, req.body.motivo);
        res.json({ success: true, data });
    });
}
