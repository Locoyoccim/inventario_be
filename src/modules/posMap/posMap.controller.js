import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class PosMapController {
    constructor(posMapService) {
        this.posMapService = posMapService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.posMapService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: await this.posMapService.getAll(empresa_id) });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const fila = await this.posMapService.getById(id, empresa_id);
        if (!fila) throw ApiError.notFound("Mapeo no encontrado");
        res.json({ success: true, data: fila });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.posMapService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const fila = await this.posMapService.upsert(empresa_id, req.body);
        res.status(201).json({ success: true, data: fila });
    });

    crearBulk = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const filas = Array.isArray(req.body) ? req.body : req.body?.mapeos;
        if (!(await this.posMapService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const data = await this.posMapService.upsertBulk(empresa_id, filas);
        res.status(201).json({ success: true, data, message: `${data.length} mapeos guardados` });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const fila = await this.posMapService.update(id, empresa_id, req.body);
        if (!fila) throw ApiError.notFound("Mapeo no encontrado");
        res.json({ success: true, data: fila });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const fila = await this.posMapService.remove(id, empresa_id);
        if (!fila) throw ApiError.notFound("Mapeo no encontrado");
        res.json({ success: true, message: "Mapeo eliminado" });
    });
}
