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

    eliminar = async (req, res) => {
        const { id } = req.params;
        try {
            await this.usuarioService.deleteUsuarios(id);
            res.status(200).json({ 
                message: "Usuario eliminado exitosamente",
                id: id
            });
        } catch (error) {
            res.status(500).json({ error: "Error al eliminar el usuario" });
        }
    };

    crear = async (req, res) => {
        const usuarioData = req.body;

        if (!usuarioData.empresa_id) {
            return res.status(400).json({ error: "empresa_id es requerido" });
        }

        try {
            const empresaExists = await this.usuarioService.existsEmpresa(
                usuarioData.empresa_id
            );
            if (!empresaExists) {
                return res.status(400).json({ error: "La empresa asociada no existe" });
            }
            const newUsuario = await this.usuarioService.createUsuario(usuarioData);
            res.status(201).json({
                message: "Usuario creado exitosamente",
                data: newUsuario
            });
        } catch (error) {
            console.error("Error al crear el usuario:", error);
            res.status(500).json({ error: "Error al crear el usuario" });
        }
    };

    actualizar = async (req, res) => {
        const { id } = req.params;
        const usuarioData = req.body;

        try {
            const updatedUsuario = await this.usuarioService.updateUsuario(
                id,
                usuarioData
            );
            res.status(200).json({
                message: "Usuario actualizado exitosamente",
                data: updatedUsuario
            });
        } catch (error) {
            res.status(500).json({ error: "Error al actualizar el usuario" });
        }
    };
}
