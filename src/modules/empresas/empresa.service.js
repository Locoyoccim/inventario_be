import ApiError from "../../utils/ApiError.js";
import { esZonaValida } from "../../utils/zonaHoraria.js";

export default class EmpresaService {
    constructor(empresaRepository) {
        this.empresaRepository = empresaRepository;
    }

    async getEmpresaById(id) {
        return await this.empresaRepository.findById(id);
    }

    async createEmpresa(data) {
        return await this.empresaRepository.create(data);
    }

    async updateEmpresa(id, data) {
        return await this.empresaRepository.update(id, data);
    }

    async deleteEmpresa(id) {
        return await this.empresaRepository.remove(id);
    }

    async getConfig(id) {
        return await this.empresaRepository.getConfig(id);
    }

    async updateConfig(id, data, aplicarARecetas = false) {
        if (data.zona_horaria !== undefined && !(await esZonaValida(data.zona_horaria)))
            throw ApiError.badRequest("zona_horaria no es válida (ej. America/Mexico_City)");
        return await this.empresaRepository.updateConfig(id, data, aplicarARecetas);
    }
}
