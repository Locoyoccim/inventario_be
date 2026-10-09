import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { registrarActividadSegura } from "../actividad/actividad.js";

export default class EmpresaController {
    constructor(empresaService) {
        this.empresaService = empresaService;
    }

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
        await registrarActividadSegura(req, {
            empresa_id: id,
            accion: "empresa.configuracion_actualizar",
            objeto_tipo: "empresa",
            objeto_id: id,
            detalle: { campos: Object.keys(req.body), aplicar_a_recetas: aplicar },
        });
        res.json({ success: true, data: cfg });
    });
}
