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

    crearEmpresa = async (req, res) => {
        const empresaData = req.body;
        try {
            const newEmpresa = await this.empresaService.createEmpresa(empresaData);
            res.status(201).json({
                message: "Empresa creada exitosamente",
                data: newEmpresa,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al crear la empresa" });
        }
    };

    actualizarEmpresa = async (req, res) => {
        const { id } = req.params;
        const empresaData = req.body;
        try {
            const updatedEmpresa = await this.empresaService.updateEmpresa(
                id,
                empresaData
            );
            res.json({
                message: "Empresa actualizada exitosamente",
                data: updatedEmpresa,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al actualizar la empresa" });
        }
    };

    eliminarEmpresa = async (req, res) => {
        const { id } = req.params;
        try {
            await this.empresaService.deleteEmpresa(id);
            res.status(200).json({
                message: "Empresa eliminada exitosamente",
                id: id,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al eliminar la empresa" });
        }
    };
}
