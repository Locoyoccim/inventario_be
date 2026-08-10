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

    crear = async (req, res) => {
        const { empresa_id } = req.params;
        const data = req.body;
        try {
            const validationError = await this.validarData(data, empresa_id);
            if (validationError) {
                return res.status(400).json({ error: validationError });
            }

            const inventario = await this.inventarioService.createInventario(data);
            res.status(201).json(inventario);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    actualizar = async (req, res) => {
        const { empresa_id, id } = req.params;
        const data = req.body;
        try {
            const validationError = await this.validarData(data, empresa_id);
            if (validationError) {
                return res.status(400).json({ error: validationError });
            }

            const inventario = await this.inventarioService.updateInventario(
                id,
                empresa_id,
                data,
            );
            if (!inventario) {
                return res.status(404).json({ error: "Inventario no encontrado" });
            }
            res.json(inventario);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    eliminar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const inventario = await this.inventarioService.deleteInventario(
                id,
                empresa_id,
            );
            if (!inventario) {
                return res.status(404).json({ error: "Inventario no encontrado" });
            }
            res.json({ message: "Inventario eliminado correctamente", id: inventario.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    validarData = async ({ producto_id, stock_actual, stock_minimo }, empresa_id) => {
        if (!producto_id) return "producto_id es requerido";
        if (stock_actual === undefined || stock_actual === null) {
            return "stock_actual es requerido";
        }
        if (stock_minimo === undefined || stock_minimo === null) {
            return "stock_minimo es requerido";
        }

        const productoExists = await this.inventarioService.existsProductoEnEmpresa(
            producto_id,
            empresa_id,
        );
        if (!productoExists) return "Producto no encontrado";

        return null;
    };
}
