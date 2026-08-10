export default class RecetaDetalle {
    constructor(recetaService) {
        this.recetaService = recetaService;
    }

    listar = async (req, res) => {
        const { receta_id } = req.params;
        try {
            const recetaExists = await this.recetaService.existsReceta(receta_id);
            if (!recetaExists) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }

            const recetaDetalles =
                await this.recetaService.getAllRecetaDetalles(receta_id);
            res.json(recetaDetalles);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    listarPorId = async (req, res) => {
        const { receta_id, id } = req.params;
        try {
            const recetaExists = await this.recetaService.existsReceta(receta_id);
            if (!recetaExists) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }

            const recetaDetalle = await this.recetaService.getRecetaDetalleById(
                receta_id,
                id,
            );
            if (!recetaDetalle) {
                return res.status(404).json({ error: "Detalle de receta no encontrado" });
            }
            res.json(recetaDetalle);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    crear = async (req, res) => {
        const { receta_id } = req.params;
        const data = req.body;
        try {
            const recetaExists = await this.recetaService.existsReceta(receta_id);
            if (!recetaExists) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }
            const recetaDetalle = await this.recetaService.createRecetaDetalle(
                receta_id,
                data,
            );
            if (!recetaDetalle) {
                return res.status(404).json({ error: "Producto no encontrado" });
            }
            res.status(201).json(recetaDetalle);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    actualizar = async (req, res) => {
        const { receta_id, id } = req.params;
        const data = req.body;
        try {
            const recetaExists = await this.recetaService.existsReceta(receta_id);
            if (!recetaExists) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }
            const recetaDetalle = await this.recetaService.updateRecetaDetalle(
                receta_id,
                id,
                data,
            );
            if (!recetaDetalle) {
                return res
                    .status(404)
                    .json({ error: "Detalle de receta o producto no encontrado" });
            }
            res.json(recetaDetalle);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    eliminar = async (req, res) => {
        const { receta_id, id } = req.params;
        try {
            const recetaExists = await this.recetaService.existsReceta(receta_id);
            if (!recetaExists) {
                return res.status(404).json({ error: "Receta no encontrada" });
            }
            const recetaDetalle = await this.recetaService.deleteRecetaDetalle(
                receta_id,
                id,
            );
            res.json(recetaDetalle);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}
