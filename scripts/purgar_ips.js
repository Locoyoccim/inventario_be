#!/usr/bin/env node
// Purga de las IP que la base guarda, para cumplir lo que dice el aviso de privacidad:
//   · bitácora de acciones (admin_actividad): `ip = NULL` en lo que pasó de 12 meses (migración 054);
//   · intentos fallidos de PIN (pin_fallos): se borran los de más de 1 día (solo sirven para contar en ventanas de minutos).
//   npm run purgar:ips
//
// Es lo que el aviso de privacidad promete. Corre con el rol de la APP (gh_app): la función de la base tiene el privilegio justo, el
// rol no puede modificar la bitácora de ninguna otra forma. Idempotente: correrlo dos veces seguidas no hace nada la segunda. Debe
// programarse a diario (docs/OBSERVABILIDAD.md §6). Códigos de salida: 0 bien · 2 error.
import { pathToFileURL } from "node:url";

/** Bitácora: cuántas filas perdieron su IP por pasar de 12 meses. */
export async function purgarIps(db) {
    const r = await db.query("SELECT public.purgar_ips_actividad() AS n");
    return Number(r.rows[0].n);
}

/** Intentos fallidos de PIN: cuántos se borraron por pasar de 1 día. */
export async function purgarPinFallos(db) {
    const r = await db.query("DELETE FROM pin_fallos WHERE created_at < now() - interval '1 day'");
    return r.rowCount;
}

async function main() {
    const { default: pool } = await import("../src/config/db.js");
    try {
        const bitacora = await purgarIps(pool);
        const pin = await purgarPinFallos(pool);
        console.log(
            `purgar:ips — ${bitacora} fila(s) de la bitácora olvidaron su IP (más de 12 meses); ${pin} intento(s) fallido(s) de PIN borrado(s) (más de 1 día).`,
        );
    } catch (e) {
        console.error(`purgar:ips falló: ${e.message}`);
        process.exitCode = 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
