import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { hoyEmpresa } from "../../utils/zonaHoraria.js";

const isFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
// Rango por defecto: últimos 30 días
async function parseRango(query, empresa_id) {
    const hasta = isFecha(query.hasta) ? query.hasta : await hoyEmpresa(empresa_id);
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
        const fecha = isFecha(req.query.fecha) ? req.query.fecha : await hoyEmpresa(empresa_id);
        res.json({ success: true, data: await this.reporteService.estadoDiario(empresa_id, fecha) });
    });

    // Señal ligera para Inicio y el menú: ¿opera con el POS? y cajas de días anteriores sin cerrar.
    pos = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const fecha = isFecha(req.query.fecha) ? req.query.fecha : await hoyEmpresa(empresa_id);
        res.json({ success: true, data: await this.reporteService.estadoPos(empresa_id, fecha) });
    });

    primerosPasos = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        res.json({ success: true, data: await this.reporteService.primerosPasos(empresa_id) });
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
        const { desde, hasta } = await parseRango(req.query, empresa_id);
        res.json({ success: true, data: await this.reporteService.actividad(empresa_id, desde, hasta) });
    });

    historial = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const { desde, hasta } = await parseRango(req.query, empresa_id);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const { rows, total } = await this.reporteService.historial(empresa_id, { desde, hasta, limit, offset });
        res.json({ success: true, data: rows, pagination: { total, limit, offset } });
    });

    consumo = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        await this.#assertEmpresa(empresa_id);
        const { desde, hasta } = await parseRango(req.query, empresa_id);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        res.json({ success: true, data: await this.reporteService.topConsumo(empresa_id, desde, hasta, limit) });
    });
}
