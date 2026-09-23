import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";

export default class RecetaController {
    constructor(recetaService) {
        this.recetaService = recetaService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const { limit, offset } = parsePagination(req.query);
        const q = (req.query.q ?? "").toString().trim() || null;
        const categoria = (req.query.categoria ?? "").toString().trim() || null;
        const incluirInactivos = ["true", "1"].includes(String(req.query.incluir_inactivos));
        const { rows, total } = await this.recetaService.getAllRecetas(empresa_id, { limit, offset, q, categoria, incluirInactivos });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const receta = await this.recetaService.getRecetaById(empresa_id, id);
        if (!receta) throw ApiError.notFound("Receta no encontrada");
        res.json({ success: true, data: receta });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const data = req.body;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const receta = Array.isArray(data.ingredientes)
            ? await this.recetaService.createRecetaConDetalle(empresa_id, data)
            : await this.recetaService.createReceta(empresa_id, data);
        res.status(201).json({ success: true, data: receta });
    });

    preview = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: await this.recetaService.previewCosteo(empresa_id, req.body) });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const receta = await this.recetaService.updateReceta(empresa_id, id, req.body);
        if (!receta) throw ApiError.notFound("Receta no encontrada");
        res.json({ success: true, data: receta });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        if (!(await this.recetaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const deleted = await this.recetaService.deleteReceta(empresa_id, id);
        if (!deleted) throw ApiError.notFound("Receta no encontrada");
        res.json({ success: true, message: "Receta eliminada correctamente" });
    });
}
