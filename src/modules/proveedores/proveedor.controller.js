export default class ProveedorController {
    constructor(proveedorService) {
        this.proveedorService = proveedorService;
    }

    listar = async (req, res) => {
        try {
            const proveedores = await this.proveedorService.getAllProveedores();
            res.json(proveedores);
        } catch (error) {
            res.status(500).json({ error: "Error al obtener los proveedores" });
        }
    };

    listarPorId = async (req, res) => {
        const { id } = req.params;
        try {
            const proveedor = await this.proveedorService.getProveedorById(id);
            res.json(proveedor);
        } catch (error) {
            console.error("Error en listar proveedores:", error);
            res.status(500).json({ error: "Error al obtener el proveedor" });
        }
    };

    eliminar = async (req, res) => {
        const { id } = req.params;
        try {
            await this.proveedorService.deleteProveedor(id);
            res.status(200).json({
                message: "Proveedor eliminado exitosamente",
                id: id,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al eliminar el proveedor" });
        }
    };

    crear = async (req, res) => {
        const proveedorData = req.body;

        if (!proveedorData.empresa_id) {
            return res.status(400).json({ error: "empresa_id es requerido" });
        }

        try {
            const empresaExists = await this.proveedorService.existsEmpresa(
                proveedorData.empresa_id,
            );
            if (!empresaExists) {
                return res.status(400).json({ error: "La empresa asociada no existe" });
            }
            const newProveedor =
                await this.proveedorService.createProveedor(proveedorData);
            res.status(201).json({
                message: "Proveedor creado exitosamente",
                data: newProveedor,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al crear el proveedor" });
        }
    };

    actualizar = async (req, res) => {
        const { id } = req.params;
        const proveedorData = req.body;

        try {
            const updatedProveedor = await this.proveedorService.updateProveedor(
                id,
                proveedorData,
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
            res.status(500).json({ error: "Error al actualizar el proveedor" });
        }
    };
}
