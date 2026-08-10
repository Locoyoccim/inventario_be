export default class InventarioController {
    constructor(inventarioService) {
        this.inventarioService = inventarioService;
    }

    listar = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const empresaExists = await this.inventarioService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const inventario = await this.inventarioService.getAllInventario(empresa_id);
            res.json(inventario);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    listarPorId = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const inventario = await this.inventarioService.getInventarioById(
                id,
                empresa_id,
            );
            if (!inventario) {
                return res.status(404).json({ error: "Inventario no encontrado" });
            }
            res.json(inventario);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

}
