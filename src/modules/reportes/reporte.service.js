export default class ReporteService {
    constructor(reporteRepository, empresaRepository) {
        this.reporteRepository = reporteRepository;
        this.empresaRepository = empresaRepository;
    }
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
    async inventario(empresa_id) {
        return await this.reporteRepository.inventarioValorizado(empresa_id);
    }
    async alertas(empresa_id) {
        return await this.reporteRepository.alertas(empresa_id);
    }
    async actividad(empresa_id, desde, hasta) {
        return await this.reporteRepository.actividad(empresa_id, desde, hasta);
    }
    async historial(empresa_id, params) {
        return await this.reporteRepository.historial(empresa_id, params);
    }
    async topConsumo(empresa_id, desde, hasta, limit) {
        return await this.reporteRepository.topConsumo(empresa_id, desde, hasta, limit);
    }
    async estadoDiario(empresa_id, fecha) {
        return await this.reporteRepository.estadoDiario(empresa_id, fecha);
    }
    async primerosPasos(empresa_id) {
        return await this.reporteRepository.primerosPasos(empresa_id);
    }
    async estadoPos(empresa_id, hoy) {
        return await this.reporteRepository.estadoPos(empresa_id, hoy);
    }
}
