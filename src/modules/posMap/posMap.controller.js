export default class PosMapController {
    constructor(posMapService) {
        this.posMapService = posMapService;
    }

    listar = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const existe = await this.posMapService.existsEmpresa(empresa_id);
            if (!existe) return res.status(404).json({ error: "Empresa no encontrada" });
            res.json(await this.posMapService.getAll(empresa_id));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    listarPorId = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const fila = await this.posMapService.getById(id, empresa_id);
            fila ? res.json(fila) : res.status(404).json({ error: "Mapeo no encontrado" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    crear = async (req, res) => {
        const { empresa_id } = req.params;
        try {
            const existe = await this.posMapService.existsEmpresa(empresa_id);
            if (!existe) return res.status(404).json({ error: "Empresa no encontrada" });
            const fila = await this.posMapService.upsert(empresa_id, req.body);
            res.status(201).json({ message: "Mapeo guardado", data: fila });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    crearBulk = async (req, res) => {
        const { empresa_id } = req.params;
        const filas = Array.isArray(req.body) ? req.body : req.body?.mapeos;
        try {
            const existe = await this.posMapService.existsEmpresa(empresa_id);
            if (!existe) return res.status(404).json({ error: "Empresa no encontrada" });
            const data = await this.posMapService.upsertBulk(empresa_id, filas);
            res.status(201).json({ message: `${data.length} mapeos guardados`, data });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    actualizar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const fila = await this.posMapService.update(id, empresa_id, req.body);
            fila
                ? res.json({ message: "Mapeo actualizado", data: fila })
                : res.status(404).json({ error: "Mapeo no encontrado" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };

    eliminar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const fila = await this.posMapService.remove(id, empresa_id);
            fila
                ? res.json({ message: "Mapeo eliminado" })
                : res.status(404).json({ error: "Mapeo no encontrado" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };
}
