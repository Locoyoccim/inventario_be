// Saneamiento de lo que llega a los logs: un log se copia, se envía a un servicio externo y se guarda meses, así que no
// debe contener secretos (tokens, contraseñas, enlaces de un solo uso) ni datos personales en claro (correos, valores de la base).

const REDACTADO = "[redactado]";

// Credenciales dentro de una URL: smtps://usuario:clave@host, postgres://usuario:clave@host...
const URL_CON_CREDENCIALES = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
// Con Unicode: un nombre con ñ o acentos (dueño@…) debe taparse entero, no solo desde la primera letra ASCII.
const CORREO = /([\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]*@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Detalle de errores de PostgreSQL: «Key (email)=(a@b.com) already exists.» → se conserva la columna, no el valor.
const COLUMNA_VALOR = /\(([^()]*)\)=\(([^)]*)\)/g;

/** `carlos@cafearoma.com` → `c***@cafearoma.com` (el dominio ayuda a depurar; la persona no queda identificada). */
export const enmascararCorreo = (texto) => String(texto).replace(CORREO, "$1***@$2");

/** Quita de un texto libre (mensajes de error, detalles de la base) lo que no debe quedar en un log. */
export function limpiarTexto(texto) {
    return String(texto)
        .replace(URL_CON_CREDENCIALES, "$1***@")
        .replace(JWT, "[jwt]")
        .replace(BEARER, `Bearer ${REDACTADO}`)
        .replace(COLUMNA_VALOR, "($1)=(***)")
        .replace(CORREO, "$1***@$2");
}

// Un segmento de ruta «opaco» (token, id aleatorio): ninguna ruta legible de la API pasa de 19 caracteres.
const SEGMENTO_OPACO = /^[A-Za-z0-9_-]{24,}$/;
// Rutas donde el segmento es siempre un secreto, tenga la longitud que tenga (un intento mal formado también lo es).
const RUTA_CON_SECRETO = /^(\/api\/auth\/invitacion\/)[^/]+/;

/**
 * Ruta para el log: sin la query (puede traer búsquedas con nombres o correos) y con los tokens enmascarados.
 * Devuelve `{ path, query_keys }`; de la query solo se conservan los NOMBRES de los parámetros.
 */
export function rutaSegura(url) {
    const [antesDeFragmento] = String(url).split("#");
    const [ruta, query] = antesDeFragmento.split("?");
    const path = ruta
        .replace(RUTA_CON_SECRETO, "$1:token")
        .split("/")
        .map((segmento) => (SEGMENTO_OPACO.test(segmento) ? ":token" : segmento))
        .join("/");
    const claves = query
        ? [
              ...new Set(
                  query
                      .split("&")
                      .map((par) => par.split("=")[0].slice(0, 40))
                      .filter(Boolean),
              ),
          ]
        : [];
    return { path, query_keys: claves.slice(0, 20) };
}

// Nombres de campo cuyo valor es un secreto, venga lo que venga dentro.
const CLAVE_SECRETA =
    /(^|[_-])(password|pass|pwd|token|secret|authorization|cookie|pin|pepper|apikey|dsn|hash)([_-]|$)|^set-cookie$|^api[_-]?key$|^codigo(_ingreso)?$/i;
const PROFUNDIDAD_MAXIMA = 4;

/** Copia del contexto de un log con los campos secretos tapados y los textos saneados. No modifica el original. */
export function limpiarContexto(valor, profundidad = 0) {
    if (typeof valor === "string") return limpiarTexto(valor);
    if (valor === null || typeof valor !== "object") return valor;
    if (profundidad >= PROFUNDIDAD_MAXIMA) return "[profundo]";
    if (valor instanceof Error) {
        return {
            name: valor.name,
            message: limpiarTexto(valor.message),
            stack: valor.stack ? limpiarTexto(valor.stack) : undefined,
        };
    }
    if (Array.isArray(valor)) return valor.map((v) => limpiarContexto(v, profundidad + 1));
    return Object.fromEntries(
        Object.entries(valor).map(([clave, v]) => [
            clave,
            CLAVE_SECRETA.test(clave) ? REDACTADO : limpiarContexto(v, profundidad + 1),
        ]),
    );
}
