export default class RecetaController {
    constructor(recetaService) {
        this.recetaService = recetaService;
    }

    listar = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const empresaExists = await this.recetaService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const recetas = await this.recetaService.getAllRecetas(empresa_id);
            res.json(recetas);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    listarPorId = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const empresaExists = await this.recetaService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const receta = await this.recetaService.getRecetaById(empresa_id, id);
            if (!receta) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }
            res.json(receta);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    crear = async (req, res) => {
        const { empresa_id } = req.params;
        const data = req.body;
        try {
            const empresaExists = await this.recetaService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }
            const receta = await this.recetaService.createReceta(empresa_id, data);
            res.status(201).json(receta);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    actualizar = async (req, res) => {
        const { empresa_id, id } = req.params;
        const data = req.body;
        try {
            const empresaExists = await this.recetaService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const receta = await this.recetaService.updateReceta(empresa_id, id, data);
            receta
                ? res.json(receta)
                : res.status(404).json({ error: "Receta no encontrada" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    eliminar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const empresaExists = await this.recetaService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(404).json({ error: "Empresa no encontrada" });
            }

            const deleted = await this.recetaService.deleteReceta(empresa_id, id);
            deleted
                ? res.json({ message: "Receta eliminada correctamente" })
                : res.status(404).json({ error: "Receta no encontrada" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };
}
