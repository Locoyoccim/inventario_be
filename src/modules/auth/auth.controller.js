import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

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
        res.status(201).json({ success: true, data });
    });

    login = asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        const data = await this.authService.login(email, password);
        res.json({ success: true, data });
    });

    me = asyncHandler(async (req, res) => {
        res.json({ success: true, data: req.user });
    });
}
