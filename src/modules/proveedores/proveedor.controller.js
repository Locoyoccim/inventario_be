export default class ProveedorController {
    constructor(proveedorService) {
        this.proveedorService = proveedorService;
    }

    listar = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const empresaExists = await this.proveedorService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const proveedores = await this.proveedorService.getAllProveedores(empresa_id);
            res.json(proveedores);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    listarPorId = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const proveedor = await this.proveedorService.getProveedorById(
                empresa_id,
                id,
            );
            if (!proveedor) {
                return res.status(404).json({ error: "Proveedor no encontrado" });
            }
            res.json(proveedor);
        } catch (error) {
            console.error("Error en listar proveedores:", error);
            res.status(500).json({ error: "Error al obtener el proveedor" });
        }
    };

    eliminar = async (req, res) => {
        const { empresa_id, id } = req.params;

        if (!empresa_id) return res.status(400).json({ error: "empresa_id es requerido" });
        if (!id) return res.status(400).json({ error: "ID es requerido" });
        try {
            await this.proveedorService.deleteProveedor(id, empresa_id);
            res.status(200).json({
                message: "Proveedor eliminado exitosamente",
                id: id,
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    crear = async (req, res) => {
        const proveedorData = req.body;
        const { empresa_id } = req.params;

        if (!proveedorData.empresa_id && !empresa_id) {
            return res.status(400).json({ error: "empresa_id es requerido" });
        }

        try {
            const empresaExists = await this.proveedorService.existsEmpresa(
                proveedorData.empresa_id || empresa_id,
            );
            if (!empresaExists) {
                return res.status(400).json({ error: "La empresa asociada no existe" });
            }
            const newProveedor = await this.proveedorService.createProveedor(
                proveedorData,
                empresa_id,
            );
            res.status(201).json({
                message: "Proveedor creado exitosamente",
                data: newProveedor,
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    actualizar = async (req, res) => {
        const { id, empresa_id } = req.params;
        const proveedorData = req.body;

        try {
            const updatedProveedor = await this.proveedorService.updateProveedor(
                id,
                proveedorData,
                empresa_id,
            );
            if (updatedProveedor) {
                res.status(200).json({
                    message: "Proveedor actualizado exitosamente",
                    data: updatedProveedor,
                });
            } else {
                res.status(404).json({ error: "Proveedor no encontrado" });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}
