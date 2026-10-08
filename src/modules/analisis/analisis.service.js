import ApiError from "../../utils/ApiError.js";
import { esFechaReal } from "../../utils/fecha.js";
import { armarConsumo, armarFugas, clasificarMenu } from "./analisis.logic.js";

const MAX_DIAS = 366;

export default class AnalisisService {
    constructor(analisisRepository) {
        this.repo = analisisRepository;
    }

    #validarRango(desde, hasta) {
        if (!esFechaReal(desde) || !esFechaReal(hasta)) throw ApiError.badRequest("desde y hasta deben ser fechas válidas (YYYY-MM-DD)");
        if (desde > hasta) throw ApiError.badRequest("desde debe ser <= hasta");
        const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
        if (dias > MAX_DIAS) throw ApiError.badRequest(`El rango máximo es ${MAX_DIAS} días`);
        return dias;
    }

    async menu(empresa_id, { desde, hasta }) {
        this.#validarRango(desde, hasta);
        const [objetivo, { filas, sinVentas }] = await Promise.all([this.repo.objetivoFoodCost(empresa_id), this.repo.menu(empresa_id, desde, hasta)]);
        return { periodo: { desde, hasta }, ...clasificarMenu(filas, { foodCostObjetivo: objetivo }), sin_ventas: sinVentas };
    }

    async consumo(empresa_id, { desde, hasta }) {
        const dias = this.#validarRango(desde, hasta);
        const [ventas, datos] = await Promise.all([
            this.repo.ventas(empresa_id, desde, hasta),
            this.repo.consumo(empresa_id, desde, hasta, dias > 120 ? "month" : "week"),
        ]);
        const ultimoConteo = new Map(datos.conteos.map((c) => [Number(c.producto_id), c.ultimo]));
        const contadosEnPeriodo = new Set(datos.conteos.filter((c) => c.en_periodo).map((c) => Number(c.producto_id)));
        return {
            periodo: { desde, hasta, agrupado: dias > 120 ? "mes" : "semana" },
            ...armarConsumo(datos.filas, { ultimoConteo, contadosEnPeriodo, ventasNetas: ventas.neto, serie: datos.serie }),
        };
    }

    async fugas(empresa_id, { desde, hasta }) {
        this.#validarRango(desde, hasta);
        const [ventas, datos] = await Promise.all([this.repo.ventas(empresa_id, desde, hasta), this.repo.fugas(empresa_id, desde, hasta)]);
        return { periodo: { desde, hasta }, ...armarFugas(datos.eventos, { ventasPorUsuario: datos.ventasPorUsuario, ventasTotal: ventas.bruto, mermaCancelaciones: datos.mermaCancelaciones }) };
    }
}
