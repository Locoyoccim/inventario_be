import pool from "../config/db.js";
import ApiError from "../utils/ApiError.js";

// router.param("receta_id"): la receta debe pertenecer a la empresa del token.
export async function recetaEmpresaGuard(req, _res, next, val) {
    try {
        if (!req.user) return next(ApiError.unauthorized());
        const r = await pool.query("SELECT empresa_id FROM recetas WHERE id = $1", [val]);
        if (!r.rows[0]) return next(ApiError.notFound("Receta no encontrada"));
        if (String(r.rows[0].empresa_id) !== String(req.user.empresa_id)) {
            return next(ApiError.forbidden("No tienes acceso a esta receta"));
        }
        next();
    } catch (e) {
        next(e);
    }
}

// Middleware para rutas /empresas/:id — el :id debe ser la empresa del token.
export function empresaSelfGuard(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    if (String(req.user.empresa_id) !== String(req.params.id)) {
        return next(ApiError.forbidden("No tienes acceso a esta empresa"));
    }
    next();
}
