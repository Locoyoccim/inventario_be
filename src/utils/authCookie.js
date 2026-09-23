// Cookie de sesión (JWT) httpOnly: el JS del navegador no puede leerla (mitiga robo por XSS).
export const AUTH_COOKIE = "gh_session";

// Header que el front manda en toda petición. Un sitio ajeno no puede agregarlo sin pasar
// por un preflight CORS, así que exigirlo en escrituras autenticadas por cookie bloquea CSRF.
export const CSRF_HEADER = "x-requested-with";

const DURACIONES = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

// "7d" | "12h" | "3600" (segundos) -> milisegundos. Debe coincidir con JWT_EXPIRES.
export function expiresToMs(value = "7d") {
    const match = /^(\d+)\s*([smhd])?$/.exec(String(value).trim());
    if (!match) return 7 * DURACIONES.d;
    const n = Number(match[1]);
    return match[2] ? n * DURACIONES[match[2]] : n * 1000;
}

export function authCookieOptions(env = process.env) {
    const production = env.NODE_ENV === "production";
    const sameSite = (env.COOKIE_SAMESITE || "lax").toLowerCase();
    const options = {
        httpOnly: true,
        // SameSite=None exige Secure; en producción siempre Secure.
        secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : production || sameSite === "none",
        sameSite,
        path: "/",
        maxAge: expiresToMs(env.JWT_EXPIRES || "7d"),
    };
    if (env.COOKIE_DOMAIN) options.domain = env.COOKIE_DOMAIN;
    return options;
}

// Mismas opciones sin maxAge (clearCookie debe coincidir en path/domain/sameSite/secure).
export function clearAuthCookieOptions(env = process.env) {
    const { maxAge: _maxAge, ...rest } = authCookieOptions(env);
    return rest;
}

// Parser mínimo del header Cookie (evita depender de cookie-parser).
export function readCookie(header, name) {
    if (!header) return null;
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        if (part.slice(0, index).trim() !== name) continue;
        const value = part.slice(index + 1).trim();
        try {
            return decodeURIComponent(value) || null;
        } catch {
            return value || null;
        }
    }
    return null;
}
