import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { hoyEmpresa } from "../../utils/zonaHoraria.js";

const esFecha = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Sin fechas: los últimos 30 días contados desde el «hoy» de la empresa.
async function rango(query, empresa_id) {
    const hasta = esFecha(query.hasta) ? query.hasta : await hoyEmpresa(empresa_id);
    let desde = esFecha(query.desde) ? query.desde : null;
    if (!desde) {
        const d = new Date(`${hasta}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 29);
        desde = d.toISOString().slice(0, 10);
    }
    return { desde, hasta };
}

export default class AnalisisController {
    constructor(analisisService) {
        this.service = analisisService;
    }

    menu = asyncHandler(async (req, res) =>
        res.json({ success: true, data: await this.service.menu(req.params.empresa_id, await rango(req.query, req.params.empresa_id)) }));
    consumo = asyncHandler(async (req, res) =>
        res.json({ success: true, data: await this.service.consumo(req.params.empresa_id, await rango(req.query, req.params.empresa_id)) }));
    fugas = asyncHandler(async (req, res) =>
        res.json({ success: true, data: await this.service.fugas(req.params.empresa_id, await rango(req.query, req.params.empresa_id)) }));
}
