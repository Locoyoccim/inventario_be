import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";

export default class ConteoController {
    constructor(conteoService) {
        this.conteoService = conteoService;
    }

    plantilla = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.conteoService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: await this.conteoService.plantilla(empresa_id) });
    });

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.conteoService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const { limit, offset } = parsePagination(req.query);
        const { rows, total } = await this.conteoService.getAll(empresa_id, { limit, offset });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.conteoService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const conteo = await this.conteoService.getById(empresa_id, id);
        if (!conteo) throw ApiError.notFound("Conteo no encontrado");
        res.json({ success: true, data: conteo });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.conteoService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const usuario_id = req.user?.id ?? null;
        const data = await this.conteoService.crear(empresa_id, { ...req.body, usuario_id });
        res.status(201).json({ success: true, data });
    });
}
