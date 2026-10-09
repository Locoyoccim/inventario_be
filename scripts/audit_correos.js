#!/usr/bin/env node
// Auditoría de CORREOS de usuarios, de solo lectura:  npm run audit:correos [-- --json]
//
// El correo identifica a la persona en toda la plataforma (el login lo busca sin empresa). Aquí se revisa que no haya dos cuentas que
// compartan correo una vez normalizado (minúsculas, sin espacios al borde) y cuántos correos aún no están normalizados. Es lo mismo que
// comprueba la migración 053 antes de aplicarse: correrlo ANTES de migrar una base con datos reales muestra qué hay que resolver a mano.
// Solo imprime ids y empresas, nunca correos. No corrige nada. Códigos de salida: 0 limpio · 1 hay duplicados · 2 error al auditar.
import { pathToFileURL } from "node:url";

/** Grupos de usuarios con el mismo correo normalizado, y cuántos correos no están en su forma normalizada. */
export async function auditarCorreos(db) {
    const dup = await db.query(`
        SELECT array_agg(id ORDER BY id) AS usuarios, array_agg(empresa_id ORDER BY id) AS empresas
          FROM usuarios
         WHERE nullif(btrim(email), '') IS NOT NULL
         GROUP BY lower(btrim(email))
        HAVING count(*) > 1
         ORDER BY min(id)`);
    const sinNormalizar = await db.query(`
        SELECT count(*)::int AS total
          FROM usuarios
         WHERE email IS NOT NULL AND email IS DISTINCT FROM nullif(lower(btrim(email)), '')`);
    return { duplicados: dup.rows, sin_normalizar: sinNormalizar.rows[0].total };
}

/** Corre `auditarCorreos` en una transacción READ ONLY que siempre termina en ROLLBACK. */
export async function auditarCorreosSoloLectura(pool) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        return await auditarCorreos(client);
    } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
    }
}

async function main() {
    const json = process.argv.includes("--json");
    const { default: pool } = await import("../src/config/db.js");
    try {
        const r = await auditarCorreosSoloLectura(pool);
        if (json) console.log(JSON.stringify(r, null, 2));
        else {
            console.log("audit:correos — solo lectura: no se corrigió nada.");
            if (r.sin_normalizar > 0)
                console.log(
                    `· ${r.sin_normalizar} correo(s) no normalizado(s): la migración 053 los normaliza sola.`,
                );
            if (r.duplicados.length === 0) console.log("✔ Ningún correo repetido.");
            else {
                console.log(`✖ ${r.duplicados.length} correo(s) compartido(s) por varias cuentas:`);
                for (const d of r.duplicados)
                    console.log(
                        `  · usuarios ${d.usuarios.join(", ")} (empresas ${d.empresas.join(", ")})`,
                    );
                console.log(
                    "\nDecide cuál cuenta conserva el correo (o si es la misma persona: acceso compartido, ADR-010). La migración 053 no migrará hasta resolverlo.",
                );
            }
        }
        process.exitCode = r.duplicados.length > 0 ? 1 : 0;
    } catch (e) {
        console.error(`audit:correos falló: ${e.message}`);
        process.exitCode = 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
