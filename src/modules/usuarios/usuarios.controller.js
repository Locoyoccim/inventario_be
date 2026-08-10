export default class UsuarioController {
    constructor(usuarioService) {
        this.usuarioService = usuarioService;
    }

    listar = async (req, res) => {
        const empresa_id = Number(req.params.empresa_id);

        if (!Number.isInteger(empresa_id) || empresa_id <= 0) {
            return res.status(400).json({ error: "empresa_id inválido" });
        }
        try {
            const usuarios = await this.usuarioService.getAllUsuarios(empresa_id);
            if (!usuarios || usuarios.length === 0) {
                return res.status(404).json({
                    error: "No se encontraron usuarios para la empresa especificada",
                });
            }
            res.json(usuarios);
        } catch (error) {
            res.status(500).json({
                error: error.message || "Error al obtener los usuarios",
            });
        }
    };

    listarPorId = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            const usuario = await this.usuarioService.getUsuarioById(empresa_id, id);
            usuario
                ? res.json(usuario)
                : res.status(404).json({ error: "Usuario no encontrado" });
        } catch (error) {
            res.status(500).json({ error: "Error al obtener el usuario" });
        }
    };

    eliminar = async (req, res) => {
        const { empresa_id, id } = req.params;
        try {
            await this.usuarioService.deleteUsuarios(empresa_id, id);
            res.status(200).json({
                message: "Usuario eliminado exitosamente",
                id: id,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al eliminar el usuario" });
        }
    };

    crear = async (req, res) => {
        const usuarioData = req.body;
        const { empresa_id } = req.params;

        if (!empresa_id) {
            return res.status(400).json({ error: "empresa_id es requerido" });
        }

        try {
            const empresaExists = await this.usuarioService.existsEmpresa(empresa_id);
            if (!empresaExists) {
                return res.status(400).json({ error: "La empresa asociada no existe" });
            }
            const newUsuario = await this.usuarioService.createUsuario(
                empresa_id,
                usuarioData,
            );
            res.status(201).json({
                message: "Usuario creado exitosamente",
                data: newUsuario,
            });
        } catch (error) {
            res.status(400).json({ error: error.message || "Error al crear el usuario" });
        }
    };

    actualizar = async (req, res) => {
        const { empresa_id, id } = req.params;
        const usuarioData = req.body;

        if (!empresa_id || !id) {
            return res.status(400).json({ error: "empresa_id e id son requeridos" });
        }

        try {
            const updatedUsuario = await this.usuarioService.updateUsuario(
                empresa_id,
                id,
                usuarioData,
            );
            updatedUsuario
                ? res.status(200).json({
                      message: "Usuario actualizado exitosamente",
                      data: updatedUsuario,
                  })
                : res.status(404).json({ error: "Usuario no encontrado" });
        } catch (error) {
            res.status(400).json({ error: error.message || "Error al actualizar el usuario" });
        }
    };
}
