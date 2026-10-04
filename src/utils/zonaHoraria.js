import pool from "../config/db.js";
import ApiError from "./ApiError.js";
import { hoyISO } from "./fecha.js";

// Zona horaria de la empresa (columna empresas.zona_horaria). Cada negocio puede estar en una región
// distinta: "hoy" y el día de cada venta se miden en SU zona, no en la del servidor ni en una global.
export async function zonaDeEmpresa(empresa_id, db = pool) {
    const r = await db.query("SELECT zona_horaria FROM empresas WHERE id = $1", [empresa_id]);
    return r.rows[0]?.zona_horaria || undefined; // undefined -> hoyISO usa TZ_NEGOCIO o México
}

// Fecha "de hoy" (YYYY-MM-DD) en la zona de la empresa.
export async function hoyEmpresa(empresa_id, db = pool, now = new Date()) {
    return hoyISO(now, await zonaDeEmpresa(empresa_id, db));
}

// Rechaza una fecha posterior al "hoy" de la empresa (un negocio en otra zona no comparte el día del servidor).
export async function exigirNoFutura(empresa_id, fecha, db = pool) {
    if (fecha > await hoyEmpresa(empresa_id, db)) throw ApiError.badRequest("la fecha no puede ser futura");
}

// ¿Es un nombre de zona horaria que Postgres acepta? (la base es quien convierte los movimientos)
export async function esZonaValida(tz, db = pool) {
    if (typeof tz !== "string" || !tz.trim()) return false;
    const r = await db.query("SELECT 1 FROM pg_timezone_names WHERE name = $1", [tz]);
    return r.rowCount > 0;
}
