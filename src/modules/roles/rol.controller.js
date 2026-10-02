import { asyncHandler } from "../../middlewares/asyncHandler.js";

export default class RolController {
    constructor(rolService) { this.rolService = rolService; }

    listar = asyncHandler(async (_req, res) => {
        res.json({ success: true, data: await this.rolService.getAll() });
    });
}
