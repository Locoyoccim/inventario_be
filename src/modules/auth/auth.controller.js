import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { aceptarInvitacion, consultarInvitacion } from "./invitacion.service.js";
import { AUTH_COOKIE, authCookieOptions, clearAuthCookieOptions } from "../../utils/authCookie.js";

export default class AuthController {
    constructor(authService) {
        this.authService = authService;
    }

    // Activación de cuenta por enlace de invitación (pública: la autoriza el token de un solo uso).
    verInvitacion = asyncHandler(async (req, res) => {
        res.json({ success: true, data: await consultarInvitacion(req.params.token) });
    });

    aceptarInvitacion = asyncHandler(async (req, res) => {
        const data = await aceptarInvitacion(req.body.token, req.body.password);
        res.json({ success: true, data });
    });

    setup = asyncHandler(async (req, res) => {
        // Si SETUP_TOKEN está definido en el entorno, exígelo por header (blindaje en producción)
        if (process.env.SETUP_TOKEN) {
            if (req.headers["x-setup-token"] !== process.env.SETUP_TOKEN) {
                throw ApiError.forbidden("SETUP_TOKEN inválido");
            }
        }
        const { token, ...data } = await this.authService.setup(req.body);
        res.cookie(AUTH_COOKIE, token, authCookieOptions());
        res.status(201).json({ success: true, data });
    });

    // La sesión web viaja SOLO en la cookie httpOnly: el JWT no se devuelve en el body (así un XSS o un log de respuestas no lo ve).
    // El middleware sigue aceptando Authorization: Bearer para integraciones futuras (ver docs/AUTH_STRATEGY.md).
    login = asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        const { token, ...data } = await this.authService.login(email, password);
        res.cookie(AUTH_COOKIE, token, authCookieOptions());
        res.json({ success: true, data });
    });

    // Público e idempotente: borra la cookie aunque ya no haya sesión (solo este dispositivo).
    logout = asyncHandler(async (_req, res) => {
        res.clearCookie(AUTH_COOKIE, clearAuthCookieOptions());
        res.json({ success: true, data: null });
    });

    // Cierra la sesión en TODOS los dispositivos (revoca los JWT vigentes del usuario).
    logoutAll = asyncHandler(async (req, res) => {
        await this.authService.logoutAll(req.user);
        res.clearCookie(AUTH_COOKIE, clearAuthCookieOptions());
        res.json({ success: true, data: null });
    });

    // Perfil actual (mismo formato que user en login). Lo usa el front al recargar.
    me = asyncHandler(async (req, res) => {
        const user = await this.authService.profile(req.user);
        if (!user) throw ApiError.unauthorized("El usuario ya no existe");
        res.json({ success: true, data: user });
    });

    // Cambio de la propia contraseña. Exenta del bloqueo de must_change_password (ver
    // requirePasswordCurrent) para que el usuario pueda resolverlo. Revoca las demás sesiones.
    changePassword = asyncHandler(async (req, res) => {
        const { password_actual, password_nueva } = req.body;
        await this.authService.changePassword(req.user, password_actual, password_nueva);
        res.json({ success: true, data: null });
    });
}
