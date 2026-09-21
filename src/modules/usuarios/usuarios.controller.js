import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class UsuarioController {
    constructor(usuarioService) {
        this.usuarioService = usuarioService;
    }

    listar = asyncHandler(async (req, res) => {
        const empresa_id = Number(req.params.empresa_id);
        if (!Number.isInteger(empresa_id) || empresa_id <= 0)
            throw ApiError.badRequest("empresa_id inválido");
        res.json({ success: true, data: await this.usuarioService.getAllUsuarios(empresa_id) });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const usuario = await this.usuarioService.getUsuarioById(empresa_id, id);
        if (!usuario) throw ApiError.notFound("Usuario no encontrado");
        res.json({ success: true, data: usuario });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.usuarioService.existsEmpresa(empresa_id)))
            throw ApiError.badRequest("La empresa asociada no existe");
        const nuevo = await this.usuarioService.createUsuario(empresa_id, req.body);
        res.status(201).json({ success: true, data: nuevo });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const actualizado = await this.usuarioService.updateUsuario(empresa_id, id, req.body);
        if (!actualizado) throw ApiError.notFound("Usuario no encontrado");
        res.json({ success: true, data: actualizado });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        await this.usuarioService.deleteUsuarios(empresa_id, id);
        res.json({ success: true, message: "Usuario eliminado exitosamente" });
    });
}
