export default class VentaController {
    constructor(ventaService) {
        this.ventaService = ventaService;
    }

    importar = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const existe = await this.ventaService.existsEmpresa(empresa_id);
            if (!existe) return res.status(404).json({ error: "Empresa no encontrada" });

            const reporte = await this.ventaService.importar(empresa_id, req.body);
            res.status(201).json({ message: "Importación procesada", data: reporte });
        } catch (error) {
            if (error.code === "DIA_YA_PROCESADO") {
                return res.status(409).json({ error: error.message });
            }
            res.status(400).json({ error: error.message });
        }
    };

    consultarDia = async (req, res) => {
        const { empresa_id, fecha } = req.params;
        try {
            const dia = await this.ventaService.consultarDia(empresa_id, fecha);
            dia ? res.json(dia) : res.status(404).json({ error: "No hay importación para esa fecha" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    revertirDia = async (req, res) => {
        const { empresa_id, fecha } = req.params;
        try {
            const r = await this.ventaService.revertirDia(empresa_id, fecha);
            r ? res.json({ message: `Día revertido (${r.revertidos} movimientos)`, data: r })
              : res.status(404).json({ error: "No hay importación para esa fecha" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };
}
