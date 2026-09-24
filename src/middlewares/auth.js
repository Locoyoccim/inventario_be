import ApiError from "../utils/ApiError.js";
import { verifyToken } from "../utils/jwt.js";
import { AUTH_COOKIE, CSRF_HEADER, readCookie } from "../utils/authCookie.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Exige un JWT válido. Fuentes, en orden:
//   1. Authorization: Bearer <token>  (Postman, integraciones, scripts)
//   2. Cookie httpOnly de sesión       (frontend web)
// Con cookie, las escrituras exigen además el header X-Requested-With (anti-CSRF).
// Coloca el payload en req.user.
export function requireAuth(req, _res, next) {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const cookieToken = bearer ? null : readCookie(req.headers.cookie, AUTH_COOKIE);
    const token = bearer || cookieToken;
    if (!token) return next(ApiError.unauthorized("Falta el token de autenticación"));

    if (cookieToken && !SAFE_METHODS.has(req.method) && !req.headers[CSRF_HEADER]) {
        return next(ApiError.forbidden("Falta el header X-Requested-With"));
    }

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

// Exige rol de dueño (is_owner). Para acciones destructivas a nivel empresa.
export function requireOwner(req, _res, next) {
    if (req.user && req.user.is_owner) return next();
    next(ApiError.forbidden("Requiere ser dueño de la empresa"));
}

// Exige el token de plataforma para operaciones de nivel plataforma (p. ej. crear empresas).
// Sin PLATFORM_TOKEN configurado en el entorno, el endpoint queda cerrado.
export function requirePlatformToken(req, _res, next) {
    const expected = process.env.PLATFORM_TOKEN;
    if (!expected || req.headers["x-platform-token"] !== expected) {
        return next(ApiError.forbidden("Operación no permitida"));
    }
    next();
}

// Rol Admin = dueño o administrador. El resto de usuarios son "Operativo".
export const requireAdmin = requireOwnerOrAdmin;
