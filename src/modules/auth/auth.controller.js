import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { AUTH_COOKIE, authCookieOptions, clearAuthCookieOptions } from "../../utils/authCookie.js";

export default class AuthController {
    constructor(authService) {
        this.authService = authService;
    }

    setup = asyncHandler(async (req, res) => {
        // Si SETUP_TOKEN está definido en el entorno, exígelo por header (blindaje en producción)
        if (process.env.SETUP_TOKEN) {
            if (req.headers["x-setup-token"] !== process.env.SETUP_TOKEN) {
                throw ApiError.forbidden("SETUP_TOKEN inválido");
            }
        }
        const data = await this.authService.setup(req.body);
        res.cookie(AUTH_COOKIE, data.token, authCookieOptions());
        res.status(201).json({ success: true, data });
    });

    // El token se entrega en cookie httpOnly (front web) y también en el body
    // (Postman/integraciones que usan Authorization: Bearer).
    login = asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        const data = await this.authService.login(email, password);
        res.cookie(AUTH_COOKIE, data.token, authCookieOptions());
        res.json({ success: true, data });
    });

    // Público e idempotente: borra la cookie aunque ya no haya sesión.
    logout = asyncHandler(async (_req, res) => {
        res.clearCookie(AUTH_COOKIE, clearAuthCookieOptions());
        res.json({ success: true, data: null });
    });

    // Perfil actual (mismo formato que user en login). Lo usa el front al recargar.
    me = asyncHandler(async (req, res) => {
        const user = await this.authService.profile(req.user);
        if (!user) throw ApiError.unauthorized("El usuario ya no existe");
        res.json({ success: true, data: user });
    });
}
