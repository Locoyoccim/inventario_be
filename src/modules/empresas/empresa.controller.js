export default class EmpresaController {
    constructor(empresaService) {
        this.empresaService = empresaService;
    }

    listar = async (req, res) => {
        try {
            const empresa = await this.empresaService.getAllEmpresas();
            res.json(empresa);
        } catch (error) {
            res.status(500).json({ error: "Error al obtener las empresas" });
        }
    };

    listarPorId = async (req, res) => {
        const { id } = req.params;
        try {
            const empresa = await this.empresaService.getEmpresaById(id);
            empresa
                ? res.json(empresa)
                : res.status(404).json({ error: "Empresa no encontrada" });
        } catch (error) {
            res.status(500).json({ error: "Error al obtener la empresa" });
        }
    };
}
