import pool from "../config/db.js";
import ApiError from "../utils/ApiError.js";

// Rechaza tokens de usuarios desactivados, refresca el rol (is_admin/is_owner) desde la BD y
// valida la versión de token (revocación por logout-all / cierre forzado). Un usuario degradado,
// desactivado o revocado pierde acceso sin esperar a que el JWT expire.
// Caché breve en memoria para no consultar la BD en cada petición.
const TTL_MS = 60 * 1000;
const cache = new Map(); // id -> { activo, is_admin, is_owner, tv, at }

export function invalidarUsuarioActivo(id) {
    cache.delete(Number(id));
}

async function cargar(id, query) {
    const key = Number(id);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const res = await query("SELECT activo, is_admin, is_owner, token_version FROM usuarios WHERE id = $1", [key]);
    const row = res.rows[0];
    const estado = row
        ? {
              activo: row.activo !== false,
              is_admin: !!row.is_admin,
              is_owner: !!row.is_owner,
              tv: Number(row.token_version ?? 0),
              at: Date.now(),
          }
        : { activo: false, is_admin: false, is_owner: false, tv: 0, at: Date.now() };
    cache.set(key, estado);
    return estado;
}

export async function estaActivo(id, query = (sql, params) => pool.query(sql, params)) {
    return (await cargar(id, query)).activo;
}

// Estado completo (activo + rol + versión de token) con la misma caché.
export async function perfilActivo(id, query = (sql, params) => pool.query(sql, params)) {
    const e = await cargar(id, query);
    return { activo: e.activo, is_admin: e.is_admin, is_owner: e.is_owner, tv: e.tv };
}

export async function requireActiveUser(req, _res, next) {
    try {
        if (!req.user?.id) return next(ApiError.unauthorized());
        const estado = await perfilActivo(req.user.id);
        if (!estado.activo) return next(ApiError.unauthorized("Usuario desactivado"));
        // Revocación: si la versión del token no coincide con la de la BD, la sesión fue cerrada.
        if (Number(req.user.tv ?? 0) !== estado.tv) {
            return next(ApiError.unauthorized("Sesión finalizada. Vuelve a iniciar sesión."));
        }
        // Rol fresco desde BD: un token viejo de un admin degradado ya no manda.
        req.user.is_admin = estado.is_admin;
        req.user.is_owner = estado.is_owner;
        next();
    } catch (error) {
        next(error);
    }
}
