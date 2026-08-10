export default class MovimientoController {
    constructor(movimientoService) {
        this.movimientoService = movimientoService;
    }

    listar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const movimientos = await this.movimientoService.getMovimientos(id, empresa_id);
            res.json(movimientos);
        } catch (error) {
            res.status(500).json({ error: "Error al obtener los movimientos" });
        }
    };

    crear = async (req, res) => {
        const { empresa_id, id } = req.params;
        const data = req.body;
        try {
            const movimiento = await this.movimientoService.registrarMovimiento(
                id,
                empresa_id,
                data,
            );
            movimiento
                ? res.status(201).json({
                      message: "Movimiento registrado exitosamente",
                      data: movimiento,
                  })
                : res.status(404).json({ error: "Producto no encontrado" });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    };
}
