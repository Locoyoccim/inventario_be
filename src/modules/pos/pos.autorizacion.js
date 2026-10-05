// Autorización de un supervisor para descuentos, cortesías, cancelaciones y anulaciones. Quien ya tiene
// `pos.autorizar` (supervisor, Admin, Owner) autoriza con su propia sesión; un cajero o mesero puede pedir que un
// supervisor autorice en su equipo con las credenciales de ese supervisor (correo y contraseña, las mismas del login).
import bcrypt from "bcryptjs";
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { permisosEfectivos } from "../../middlewares/activeUser.js";

// Se compara siempre contra un hash (aunque el correo no exista) para que el tiempo no delate qué correos existen.
const HASH_DUMMY = bcrypt.hashSync("sin-usuario", 10);

// Una sesión de PIN no autoriza por sí misma: el supervisor la confirma con su correo y contraseña (credenciales en el cuerpo).
export const puedeAutorizarUsuario = (u) => Boolean(u && !u.pin && (u.is_admin || u.is_owner || u.permisos?.includes("pos.autorizar")));

// Devuelve el id de quien autoriza o null si nadie autoriza (sin sesión con permiso ni credenciales).
export async function resolverAutorizador(empresa_id, actor, credenciales) {
    if (actor.puedeAutorizar) return actor.id;
    if (!credenciales) return null;
    const r = await pool.query(
        `SELECT u.id, u.password_hash, u.activo, u.is_admin, u.is_owner, u.role_id, r.permisos
         FROM usuarios u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.empresa_id = $1 AND lower(u.email) = lower($2) LIMIT 1`,
        [empresa_id, credenciales.email],
    );
    const u = r.rows[0];
    const ok = await bcrypt.compare(credenciales.password, u?.password_hash ?? HASH_DUMMY);
    if (!u || !u.password_hash || !ok || u.activo === false) throw ApiError.forbidden("Credenciales del supervisor no válidas");
    const permisos = permisosEfectivos(u.role_id, u.permisos);
    if (!u.is_admin && !u.is_owner && !permisos.includes("pos.autorizar")) throw ApiError.forbidden("Ese usuario no tiene permiso para autorizar");
    return u.id;
}

export const exigirAutorizador = (autorizador_id) => {
    if (!autorizador_id) throw ApiError.forbidden("Esta acción requiere la autorización de un supervisor");
    return autorizador_id;
};

export async function registrarAutorizacion(db, { empresa_id, cuenta_id, item_id = null, tipo, monto = 0, motivo = null, autorizado_por, solicitado_por = null }) {
    await db.query(
        `INSERT INTO pos_autorizaciones (empresa_id, cuenta_id, item_id, tipo, monto, motivo, autorizado_por, solicitado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [empresa_id, cuenta_id, item_id, tipo, monto, motivo, autorizado_por, solicitado_por],
    );
}
