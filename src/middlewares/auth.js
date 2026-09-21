import ApiError from "../utils/ApiError.js";
import { verifyToken } from "../utils/jwt.js";

// Exige un JWT válido en Authorization: Bearer <token>. Coloca el payload en req.user.
export function requireAuth(req, _res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return next(ApiError.unauthorized("Falta el token de autenticación"));
    try {
        req.user = verifyToken(token);
        next();
    } catch {
        next(ApiError.unauthorized("Token inválido o expirado"));
    }
}

// router.param: valida que el :empresa_id de la URL coincida con el del token.
export function empresaGuard(req, _res, next, val) {
    if (!req.user) return next(ApiError.unauthorized());
    if (String(req.user.empresa_id) !== String(val)) {
        return next(ApiError.forbidden("No tienes acceso a los datos de esta empresa"));
    }
    next();
}

// Helper opcional para exigir rol elevado (dueño/admin).
export function requireOwnerOrAdmin(req, _res, next) {
    if (req.user && (req.user.is_owner || req.user.is_admin)) return next();
    next(ApiError.forbidden("Requiere permisos de administrador"));
}
