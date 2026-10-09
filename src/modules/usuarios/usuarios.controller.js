import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { registrarActividadSegura } from "../actividad/actividad.js";

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

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.usuarioService.existsEmpresa(empresa_id)))
            throw ApiError.badRequest("La empresa asociada no existe");
        const nuevo = await this.usuarioService.createUsuario(empresa_id, req.body);
        await registrarActividadSegura(req, {
            empresa_id,
            accion: "usuario.crear",
            objeto_tipo: "usuario",
            objeto_id: nuevo?.id,
            detalle: {
                is_admin: Boolean(req.body.is_admin),
                role_id: req.body.role_id ?? null,
                con_correo: Boolean(req.body.email),
                con_contrasena: Boolean(req.body.password),
            },
        });
        res.status(201).json({ success: true, data: nuevo });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const actualizado = await this.usuarioService.updateUsuario(
            empresa_id,
            id,
            req.body,
            req.user,
        );
        if (!actualizado) throw ApiError.notFound("Usuario no encontrado");
        const { password, forzar_cierre_sesion, ...cambios } = req.body;
        await registrarActividadSegura(req, {
            empresa_id,
            accion: "usuario.actualizar",
            objeto_tipo: "usuario",
            objeto_id: id,
            // Solo los NOMBRES de los campos y las banderas: ni la contraseña ni el contenido de los cambios.
            detalle: {
                campos: Object.keys(cambios),
                ...(cambios.activo !== undefined ? { activo: Boolean(cambios.activo) } : {}),
                ...(cambios.is_admin !== undefined ? { is_admin: Boolean(cambios.is_admin) } : {}),
                ...(cambios.role_id !== undefined ? { role_id: cambios.role_id } : {}),
                contrasena_cambiada: Boolean(password),
                cierre_sesiones_forzado: Boolean(forzar_cierre_sesion),
            },
        });
        res.json({ success: true, data: actualizado });
    });
}
