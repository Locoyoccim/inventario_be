import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { registrarActividadSegura, contextoActividad } from "../actividad/actividad.js";

export default class PlatformController {
    constructor(platformService) {
        this.platformService = platformService;
    }

    listarEmpresas = asyncHandler(async (req, res) => {
        const data = await this.platformService.listarEmpresas();
        res.json({ success: true, data });
    });

    crearEmpresa = asyncHandler(async (req, res) => {
        // La bitácora de esta acción se escribe DENTRO de la transacción que crea la empresa y su Owner (ver el repositorio).
        const data = await this.platformService.crearEmpresa(req.body, contextoActividad(req));
        res.status(201).json({ success: true, data });
    });

    reenviarInvitacion = asyncHandler(async (req, res) => {
        const data = await this.platformService.reenviarInvitacion(req.params.id);
        await registrarActividadSegura(req, {
            empresa_id: req.params.id,
            accion: "plataforma.invitacion_reenviar",
            objeto_tipo: "empresa",
            objeto_id: req.params.id,
        });
        res.json({ success: true, data });
    });

    cambiarEstado = asyncHandler(async (req, res) => {
        const data = await this.platformService.cambiarEstado(req.params.id, req.body.activo);
        await registrarActividadSegura(req, {
            empresa_id: req.params.id,
            accion: "plataforma.empresa_estado",
            objeto_tipo: "empresa",
            objeto_id: req.params.id,
            detalle: { activo: Boolean(req.body.activo) },
        });
        res.json({ success: true, data });
    });

    resetearPasswordOwner = asyncHandler(async (req, res) => {
        const data = await this.platformService.resetearPasswordOwner(
            req.params.id,
            req.body.password,
        );
        // Nunca la contraseña nueva: solo a quién se le restableció.
        await registrarActividadSegura(req, {
            empresa_id: req.params.id,
            accion: "plataforma.owner_password_resetear",
            objeto_tipo: "usuario",
            objeto_id: data?.id,
        });
        res.json({ success: true, data });
    });
}
