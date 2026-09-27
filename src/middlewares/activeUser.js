import pool from "../config/db.js";
import ApiError from "../utils/ApiError.js";

// Rechaza tokens de usuarios desactivados o cuya empresa fue desactivada, refresca el rol
// (is_admin/is_owner/is_platform_admin/must_change_password) desde la BD y valida la versión
// de token (revocación por logout-all / cierre forzado). Un usuario degradado, desactivado o
// revocado pierde acceso sin esperar a que el JWT expire.
// Caché breve en memoria para no consultar la BD en cada petición.
const TTL_MS = 60 * 1000;
const cache = new Map(); // id -> { activo, empresa_activa, is_admin, is_owner, is_platform_admin, must_change_password, tv, at }

export function invalidarUsuarioActivo(id) {
    cache.delete(Number(id));
}

async function cargar(id, query) {
    const key = Number(id);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const res = await query(
        `SELECT u.activo, u.is_admin, u.is_owner, u.is_platform_admin, u.must_change_password,
                u.token_version, e.activo AS empresa_activa
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
         WHERE u.id = $1`,
        [key]
    );
    const row = res.rows[0];
    const estado = row
        ? {
              activo: row.activo !== false,
              empresa_activa: row.empresa_activa !== false,
              is_admin: !!row.is_admin,
              is_owner: !!row.is_owner,
              is_platform_admin: !!row.is_platform_admin,
              must_change_password: !!row.must_change_password,
              tv: Number(row.token_version ?? 0),
              at: Date.now(),
          }
        : {
              activo: false, empresa_activa: false, is_admin: false, is_owner: false,
              is_platform_admin: false, must_change_password: false, tv: 0, at: Date.now(),
          };
    cache.set(key, estado);
    return estado;
}

export async function estaActivo(id, query = (sql, params) => pool.query(sql, params)) {
    const e = await cargar(id, query);
    return e.activo && e.empresa_activa;
}

// Estado completo (activo + rol + versión de token) con la misma caché.
export async function perfilActivo(id, query = (sql, params) => pool.query(sql, params)) {
    return await cargar(id, query);
}

export async function requireActiveUser(req, _res, next) {
    try {
        if (!req.user?.id) return next(ApiError.unauthorized());
        const estado = await perfilActivo(req.user.id);
        if (!estado.activo) return next(ApiError.unauthorized("Usuario desactivado"));
        if (!estado.empresa_activa) return next(ApiError.unauthorized("La empresa fue desactivada. Contacta al administrador."));
        // Revocación: si la versión del token no coincide con la de la BD, la sesión fue cerrada.
        if (Number(req.user.tv ?? 0) !== estado.tv) {
            return next(ApiError.unauthorized("Sesión finalizada. Vuelve a iniciar sesión."));
        }
        // Rol fresco desde BD: un token viejo de un admin degradado ya no manda.
        req.user.is_admin = estado.is_admin;
        req.user.is_owner = estado.is_owner;
        req.user.is_platform_admin = estado.is_platform_admin;
        req.user.must_change_password = estado.must_change_password;
        next();
    } catch (error) {
        next(error);
    }
}

// Bloquea el resto de la API (no /auth/*) mientras el usuario tenga una contraseña temporal
// pendiente de cambiar. Solo aplica a las rutas de negocio (montadas después de este guard en
// app.js); /auth/me, /auth/logout* y /auth/password quedan exentas para que el usuario pueda
// leer su perfil y cambiar la contraseña. Requiere que requireActiveUser haya corrido antes
// (lee req.user.must_change_password, ya refrescado desde la BD).
export function requirePasswordCurrent(req, _res, next) {
    if (req.user?.must_change_password) {
        return next(ApiError.forbidden("Debes cambiar tu contraseña antes de continuar"));
    }
    next();
}
