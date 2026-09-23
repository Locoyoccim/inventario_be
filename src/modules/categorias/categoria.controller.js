import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class CategoriaController {
    constructor(categoriaService) { this.categoriaService = categoriaService; }

    async #assertEmpresa(empresa_id) {
        if (!(await this.categoriaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        res.json({ success: true, data: await this.categoriaService.getAll(empresa_id) });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        res.status(201).json({ success: true, data: await this.categoriaService.crear(empresa_id, req.body) });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const cat = await this.categoriaService.actualizar(empresa_id, id, req.body);
        if (!cat) throw ApiError.notFound("Categoría no encontrada");
        res.json({ success: true, data: cat });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const del = await this.categoriaService.eliminar(empresa_id, id);
        if (!del) throw ApiError.notFound("Categoría no encontrada");
        res.json({ success: true, message: "Categoría eliminada" });
    });
}
