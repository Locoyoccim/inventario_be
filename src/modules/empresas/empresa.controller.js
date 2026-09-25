import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class EmpresaController {
    constructor(empresaService) {
        this.empresaService = empresaService;
    }

    listar = asyncHandler(async (req, res) => {
        // Un usuario solo ve su propia empresa (no se listan todas las del sistema)
        const propia = await this.empresaService.getEmpresaById(req.user.empresa_id);
        res.json({ success: true, data: propia ? [propia] : [] });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const empresa = await this.empresaService.getEmpresaById(id);
        if (!empresa) throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: empresa });
    });

    crearEmpresa = asyncHandler(async (req, res) => {
        const nueva = await this.empresaService.createEmpresa(req.body);
        res.status(201).json({ success: true, data: nueva });
    });

    actualizarEmpresa = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const actualizada = await this.empresaService.updateEmpresa(id, req.body);
        if (!actualizada) throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: actualizada });
    });

    getConfiguracion = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const cfg = await this.empresaService.getConfig(id);
        if (!cfg) throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: cfg });
    });

    actualizarConfiguracion = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const aplicar = ["true", "1"].includes(String(req.query.aplicar_a_recetas));
        const cfg = await this.empresaService.updateConfig(id, req.body, aplicar);
        if (!cfg) throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: cfg });
    });

    eliminarEmpresa = asyncHandler(async (req, res) => {
        const { id } = req.params;
        await this.empresaService.deleteEmpresa(id);
        res.json({ success: true, message: "Empresa eliminada exitosamente" });
    });
}
