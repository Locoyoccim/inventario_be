import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

const isFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const hoyISO = () => new Date().toISOString().slice(0, 10);
// Rango por defecto: últimos 30 días
function parseRango(query) {
    const hasta = isFecha(query.hasta) ? query.hasta : hoyISO();
    let desde = isFecha(query.desde) ? query.desde : null;
    if (!desde) {
        const d = new Date(hasta + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() - 29);
        desde = d.toISOString().slice(0, 10);
    }
    return { desde, hasta };
}

export default class ReporteController {
    constructor(reporteService) {
        this.reporteService = reporteService;
    }

    async #assertEmpresa(empresa_id) {
        if (!(await this.reporteService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
    }

    estado = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const fecha = isFecha(req.query.fecha) ? req.query.fecha : hoyISO();
        res.json({ success: true, data: await this.reporteService.estadoDiario(empresa_id, fecha) });
    });

    inventario = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        res.json({ success: true, data: await this.reporteService.inventario(empresa_id) });
    });

    alertas = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        res.json({ success: true, data: await this.reporteService.alertas(empresa_id) });
    });

    actividad = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const { desde, hasta } = parseRango(req.query);
        res.json({ success: true, data: await this.reporteService.actividad(empresa_id, desde, hasta) });
    });

    consumo = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const { desde, hasta } = parseRango(req.query);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        res.json({ success: true, data: await this.reporteService.topConsumo(empresa_id, desde, hasta, limit) });
    });
}
