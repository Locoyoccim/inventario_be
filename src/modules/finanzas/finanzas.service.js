import { armarResumen } from "./finanzas.logic.js";
import ApiError from "../../utils/ApiError.js";
import { esFechaReal } from "../../utils/fecha.js";

const UNIDAD = { dia: "day", semana: "week", mes: "month" };

export default class FinanzasService {
    constructor(finanzasRepository) {
        this.repo = finanzasRepository;
    }

    // Categorías
    listarCategorias(e, inc) { return this.repo.listarCategorias(e, inc); }
    crearCategoria(e, nombre) { return this.repo.crearCategoria(e, nombre); }
    actualizarCategoria(e, id, data) { return this.repo.actualizarCategoria(e, id, data); }

    // Gastos
    listarGastos(e, filtros, solo) { return this.repo.listarGastos(e, filtros, solo); }
    crearGasto(e, data, uid) { return this.repo.crearGasto(e, data, uid); }
    actualizarGasto(e, id, data) { return this.repo.actualizarGasto(e, id, data); }
    anularGasto(e, id, uid, motivo) { return this.repo.anularGasto(e, id, uid, motivo); }

    // Ingresos
    listarIngresos(e, filtros, solo) { return this.repo.listarIngresos(e, filtros, solo); }
    crearIngreso(e, data, uid) { return this.repo.crearIngreso(e, data, uid); }
    crearIngresosLote(e, fecha, lineas, uid) { return this.repo.crearIngresosLote(e, fecha, lineas, uid); }
    actualizarIngreso(e, id, data) { return this.repo.actualizarIngreso(e, id, data); }
    anularIngreso(e, id, uid, motivo) { return this.repo.anularIngreso(e, id, uid, motivo); }

    // Libro
    listarMovimientos(e, filtros) { return this.repo.listarMovimientos(e, filtros); }

    // Resumen
    async getResumen(e, { desde, hasta, agrupar }) {
        if (!desde || !hasta) throw ApiError.badRequest("desde y hasta son requeridos (YYYY-MM-DD)");
        if (!esFechaReal(desde) || !esFechaReal(hasta)) throw ApiError.badRequest("fechas inválidas (YYYY-MM-DD)");
        if (desde > hasta) throw ApiError.badRequest("desde debe ser <= hasta");
        const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
        if (dias > 366) throw ApiError.badRequest("El rango máximo es 366 días");
        const unit = UNIDAD[agrupar] || "day";
        const raw = await this.repo.resumenRaw(e, { desde, hasta, unit });
        return armarResumen({ periodo: { desde, hasta }, ...raw });
    }
}
