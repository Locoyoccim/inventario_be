import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class VentaController {
    constructor(ventaService) {
        this.ventaService = ventaService;
    }

    importar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.ventaService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        const reporte = await this.ventaService.importar(empresa_id, req.body);
        res.status(201).json({ success: true, data: reporte });
    });

    consultarDia = asyncHandler(async (req, res) => {
        const { empresa_id, fecha } = req.params;
        const dia = await this.ventaService.consultarDia(empresa_id, fecha);
        if (!dia) throw ApiError.notFound("No hay importación para esa fecha");
        res.json({ success: true, data: dia });
    });

    revertirDia = asyncHandler(async (req, res) => {
        const { empresa_id, fecha } = req.params;
        const r = await this.ventaService.revertirDia(empresa_id, fecha);
        if (!r) throw ApiError.notFound("No hay importación para esa fecha");
        res.json({ success: true, message: `Día revertido (${r.revertidos} movimientos)`, data: r });
    });
}
