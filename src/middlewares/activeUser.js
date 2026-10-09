import pool from "../config/db.js";
import ApiError from "../utils/ApiError.js";

// Rechaza tokens de usuarios desactivados o cuya empresa fue desactivada, refresca el rol
// (is_admin/is_owner/is_platform_admin/must_change_password) desde la BD y valida la versión
// de token (revocación por logout-all / cierre forzado). Un usuario degradado, desactivado o
// revocado pierde acceso sin esperar a que el JWT expire.
// Caché breve en memoria para no consultar la BD en cada petición.
const TTL_MS = 60 * 1000;
// id -> { activo, empresa_id (base), empresa_activa (de la base), is_admin, is_owner, is_platform_admin, must_change_password, permisos, tv,
//         accesos: Map<empresa_id, { is_admin, permisos, empresa_activa }> (accesos compartidos VIGENTES), at }
const cache = new Map();

export function invalidarUsuarioActivo(id) {
    cache.delete(Number(id));
}

// Equipos registrados (sesiones de PIN): un equipo revocado deja sin acceso a sus sesiones aunque el JWT no haya vencido.
const cacheEquipos = new Map(); // id -> { activo, at }
export function invalidarDispositivo(id) {
    cacheEquipos.delete(Number(id));
}
async function equipoActivo(id, query) {
    const key = Number(id);
    const hit = cacheEquipos.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.activo;
    const r = await query(
        "SELECT 1 FROM dispositivos d JOIN empresas e ON e.id = d.empresa_id WHERE d.id = $1 AND d.activo AND e.activo",
        [key],
    );
    const activo = r.rowCount > 0;
    cacheEquipos.set(key, { activo, at: Date.now() });
    return activo;
}

// Operativo sin role_id asignado (usuarios creados antes de este sistema de permisos, o
// simplemente sin rol elegido): conserva el acceso que siempre tuvo, igual al rol "completo".
const PERMISOS_SIN_ROL = [
    "compras.crear",
    "conteos.crear",
    "produccion.crear",
    "gastos.crear",
    "ingresos.crear",
];

export function permisosEfectivos(role_id, permisos) {
    return role_id == null ? PERMISOS_SIN_ROL : (permisos ?? []);
}

async function cargar(id, query) {
    const key = Number(id);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const res = await query(
        `SELECT u.empresa_id, u.activo, u.is_admin, u.is_owner, u.is_platform_admin, u.must_change_password,
                u.token_version, u.role_id, r.permisos, e.activo AS empresa_activa
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [key],
    );
    const row = res.rows[0];
    // Accesos compartidos vigentes (Owner/Admin al que el maestro dio otra empresa): cada uno con SU rol. Sin la fila no hay acceso.
    const accesos = new Map();
    if (row) {
        const acc = await query(
            `SELECT ue.empresa_id, ue.is_admin, ue.role_id, r.permisos, e.activo AS empresa_activa
             FROM usuario_empresas ue
             JOIN empresas e ON e.id = ue.empresa_id
             LEFT JOIN roles r ON r.id = ue.role_id
             WHERE ue.usuario_id = $1 AND ue.activo`,
            [key],
        );
        for (const a of acc.rows) {
            accesos.set(Number(a.empresa_id), {
                is_admin: !!a.is_admin,
                permisos: permisosEfectivos(a.role_id, a.permisos),
                empresa_activa: a.empresa_activa !== false,
            });
        }
    }
    const estado = row
        ? {
              empresa_id: Number(row.empresa_id),
              activo: row.activo !== false,
              empresa_activa: row.empresa_activa !== false,
              is_admin: !!row.is_admin,
              is_owner: !!row.is_owner,
              is_platform_admin: !!row.is_platform_admin,
              must_change_password: !!row.must_change_password,
              permisos: permisosEfectivos(row.role_id, row.permisos),
              tv: Number(row.token_version ?? 0),
              accesos,
              at: Date.now(),
          }
        : {
              empresa_id: null,
              activo: false,
              empresa_activa: false,
              is_admin: false,
              is_owner: false,
              is_platform_admin: false,
              must_change_password: false,
              permisos: [],
              tv: 0,
              accesos,
              at: Date.now(),
          };
    cache.set(key, estado);
    return estado;
}

// Lo que `estado` dice de la persona EN la empresa `empresa_id`: la base (su fila) o un acceso compartido vigente. null = no le
// corresponde esa empresa. En un acceso compartido nunca es Owner y su rol es el del acceso, no el de su fila base.
export function contextoEmpresa(estado, empresa_id) {
    const id = Number(empresa_id);
    if (id === estado.empresa_id) {
        return {
            base: true,
            empresa_activa: estado.empresa_activa,
            is_admin: estado.is_admin,
            is_owner: estado.is_owner,
            permisos: estado.permisos,
        };
    }
    const acceso = estado.accesos?.get(id);
    if (!acceso) return null;
    return {
        base: false,
        empresa_activa: acceso.empresa_activa,
        is_admin: acceso.is_admin,
        is_owner: false,
        permisos: acceso.permisos,
    };
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
        // El tenant del token debe ser el de la fila del usuario (su empresa base) o un acceso compartido VIGENTE: el aislamiento no puede
        // descansar solo en un claim del JWT. Un acceso retirado o una empresa que ya no le corresponde pierde la sesión (401).
        const ctx = contextoEmpresa(estado, req.user.empresa_id);
        if (!ctx) {
            return next(
                ApiError.unauthorized(
                    "La sesión no corresponde a tu empresa. Vuelve a iniciar sesión.",
                ),
            );
        }
        if (!ctx.empresa_activa)
            return next(
                ApiError.unauthorized("La empresa fue desactivada. Contacta al administrador."),
            );
        // Revocación: si la versión del token no coincide con la de la BD, la sesión fue cerrada.
        if (Number(req.user.tv ?? 0) !== estado.tv) {
            return next(ApiError.unauthorized("Sesión finalizada. Vuelve a iniciar sesión."));
        }
        // Sesión de PIN: solo vale mientras el equipo siga autorizado y la persona no sea administradora (si la ascendieron,
        // vuelve a entrar con correo y contraseña; una sesión de PIN nunca hereda poderes de Admin).
        if (req.user.pin) {
            // Un equipo y su PIN son de la empresa base: nunca valen en una empresa compartida.
            if (!ctx.base) {
                return next(
                    ApiError.unauthorized(
                        "Esta sesión ya no es válida. Entra con tu correo y contraseña.",
                    ),
                );
            }
            if (estado.is_admin || estado.is_owner || estado.is_platform_admin) {
                return next(
                    ApiError.unauthorized(
                        "Esta sesión ya no es válida. Entra con tu correo y contraseña.",
                    ),
                );
            }
            if (!(await equipoActivo(req.user.disp, (sql, params) => pool.query(sql, params)))) {
                return next(
                    ApiError.unauthorized(
                        "Este equipo ya no está autorizado. Pide a un administrador que lo registre de nuevo.",
                    ),
                );
            }
        }
        // Rol fresco desde BD: un token viejo de un admin degradado ya no manda.
        req.user.is_admin = ctx.is_admin;
        req.user.is_owner = ctx.is_owner;
        req.user.is_platform_admin = estado.is_platform_admin;
        req.user.must_change_password = estado.must_change_password;
        req.user.permisos = ctx.permisos;
        // Empresa base de la persona (la de su fila): lo que depende de SU cuenta —contraseña, cierre de sesiones— no sigue a la empresa activa.
        req.user.empresa_base = estado.empresa_id;
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
