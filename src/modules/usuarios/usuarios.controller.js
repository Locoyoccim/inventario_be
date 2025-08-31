export default class UsuarioController {
    constructor(usuarioService) {
        this.usuarioService = usuarioService;
    }

    listar = async (req, res) => {
        try {
            const usuarios = await this.usuarioService.getAllUsuarios();
            res.json(usuarios);
        } catch (error) {
            res.status(500).json({ error: "Error al obtener los usuarios" });
        }
    };

    listarPorId = async (req, res) => {
        const { id } = req.params;
        try {
            const usuario = await this.usuarioService.getUsuarioById(id);
            usuario
                ? res.json(usuario)
                : res.status(404).json({ error: "Usuario no encontrado" });
        } catch (error) {
            res.status(500).json({ error: "Error al obtener el usuario" });
        }
    };
}
