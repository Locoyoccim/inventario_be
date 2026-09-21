import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class RecetaDetalleController {
    constructor(recetaService) {
        this.recetaService = recetaService;
    }

    listar = asyncHandler(async (req, res) => {
        const { receta_id } = req.params;
        if (!(await this.recetaService.existsReceta(receta_id)))
            throw ApiError.notFound("Receta no encontrada");
        res.json({ success: true, data: await this.recetaService.getAllRecetaDetalles(receta_id) });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { receta_id, id } = req.params;
        if (!(await this.recetaService.existsReceta(receta_id)))
            throw ApiError.notFound("Receta no encontrada");
        const detalle = await this.recetaService.getRecetaDetalleById(receta_id, id);
        if (!detalle) throw ApiError.notFound("Detalle de receta no encontrado");
        res.json({ success: true, data: detalle });
    });

    crear = asyncHandler(async (req, res) => {
        const { receta_id } = req.params;
        if (!(await this.recetaService.existsReceta(receta_id)))
            throw ApiError.notFound("Receta no encontrada");
        const detalle = await this.recetaService.createRecetaDetalle(receta_id, req.body);
        if (!detalle) throw ApiError.notFound("Producto no encontrado");
        res.status(201).json({ success: true, data: detalle });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { receta_id, id } = req.params;
        if (!(await this.recetaService.existsReceta(receta_id)))
            throw ApiError.notFound("Receta no encontrada");
        const detalle = await this.recetaService.updateRecetaDetalle(receta_id, id, req.body);
        if (!detalle) throw ApiError.notFound("Detalle de receta o producto no encontrado");
        res.json({ success: true, data: detalle });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { receta_id, id } = req.params;
        if (!(await this.recetaService.existsReceta(receta_id)))
            throw ApiError.notFound("Receta no encontrada");
        const detalle = await this.recetaService.deleteRecetaDetalle(receta_id, id);
        if (!detalle) throw ApiError.notFound("Detalle de receta no encontrado");
        res.json({ success: true, message: "Detalle de receta eliminado correctamente" });
    });
}
