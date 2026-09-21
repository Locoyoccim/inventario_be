import { parseToteatCsv } from "../../utils/parseToteat.js";
import ApiError from "../../utils/ApiError.js";

export default class VentaService {
    constructor(ventaRepository, empresaRepository) {
        this.ventaRepository = ventaRepository;
        this.empresaRepository = empresaRepository;
    }

    // Acepta líneas ya estructuradas [{nombre_pos, cantidad}] o un CSV crudo de Toteat.
    async importar(empresa_id, { fecha, lineas, csv }, opts) {
        if (!fecha) throw ApiError.badRequest("fecha es requerida (formato YYYY-MM-DD)");

        let filas = lineas;
        if ((!filas || filas.length === 0) && csv) {
            filas = parseToteatCsv(csv);
        }
        if (!Array.isArray(filas) || filas.length === 0) {
            throw ApiError.badRequest("No hay líneas de venta: envía 'lineas' [{nombre_pos, cantidad}] o 'csv'");
        }
        return await this.ventaRepository.importarDia(empresa_id, fecha, filas, opts);
    }

    async consultarDia(empresa_id, fecha) {
        return await this.ventaRepository.consultarDia(empresa_id, fecha);
    }

    async revertirDia(empresa_id, fecha) {
        return await this.ventaRepository.revertirDia(empresa_id, fecha);
    }

    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
