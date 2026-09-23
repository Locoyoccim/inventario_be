import pool from "../config/db.js";
import ApiError from "../utils/ApiError.js";

// Rechaza tokens de usuarios desactivados (o borrados) sin esperar a que el JWT expire.
// Cache breve en memoria para no consultar la BD en cada peticion.
const TTL_MS = 60 * 1000;
const cache = new Map(); // id -> { activo, at }

export function invalidarUsuarioActivo(id) {
    cache.delete(Number(id));
}

export async function estaActivo(id, query = (sql, params) => pool.query(sql, params)) {
    const key = Number(id);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.activo;
    const res = await query("SELECT activo FROM usuarios WHERE id = $1", [key]);
    const activo = res.rows[0] ? res.rows[0].activo !== false : false;
    cache.set(key, { activo, at: Date.now() });
    return activo;
}

export async function requireActiveUser(req, _res, next) {
    try {
        if (!req.user?.id) return next(ApiError.unauthorized());
        if (!(await estaActivo(req.user.id))) return next(ApiError.unauthorized("Usuario desactivado"));
        next();
    } catch (error) {
        next(error);
    }
}
