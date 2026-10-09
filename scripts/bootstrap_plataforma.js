#!/usr/bin/env node
// Primer usuario MAESTRO de plataforma en una base vacía:  npm run bootstrap:plataforma [-- --otro]
//
// Por qué existe: ninguna migración crea empresas ni usuarios, y /api/auth/setup necesita una empresa que ya exista y no marca a nadie como
// maestro. Sin esto, una base nueva no tiene quién cree las empresas de los clientes (Plataforma → Empresas). El maestro es además
// Owner/Admin de su propia empresa «de plataforma» (sin datos operativos de los clientes).
//
// Entrada, por variables de entorno (las escribes tú en el panel del host; ni este script ni quien lo lanza ven la contraseña):
//   BOOTSTRAP_EMAIL      correo del maestro (se normaliza a minúsculas)
//   BOOTSTRAP_PASSWORD   contraseña TEMPORAL (12+ caracteres): en el primer ingreso se obliga a cambiarla
//   BOOTSTRAP_NOMBRE     opcional (por defecto «Administrador de plataforma»)
//   BOOTSTRAP_EMPRESA    opcional (por defecto «Plataforma»)
// Se conecta con DATABASE_URL (el rol de la app basta: solo INSERT en empresas y usuarios). No imprime la contraseña ni el correo.
//
// Idempotente: si ese correo ya es maestro no hace nada; si ya hay OTRO maestro se detiene (usa --otro para crear uno más a propósito).
// Códigos de salida: 0 creado o ya estaba · 1 se detuvo (otro maestro, correo de un usuario común) · 2 error o entrada inválida.
import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAVE_DEL_CANDADO = 7240518; // distinta de la de las pruebas (test/helpers/exclusion.js)

export class BootstrapError extends Error {
    constructor(mensaje, codigo = 2) {
        super(mensaje);
        this.codigo = codigo;
    }
}

/** Valida y normaliza la entrada. Lanza BootstrapError (código 2) con un mensaje que no incluye la contraseña. */
export function leerEntrada(env) {
    const email = (env.BOOTSTRAP_EMAIL ?? "").trim().toLowerCase();
    if (!CORREO.test(email))
        throw new BootstrapError("BOOTSTRAP_EMAIL falta o no es un correo válido");
    const password = env.BOOTSTRAP_PASSWORD ?? "";
    if (password.length < 12)
        throw new BootstrapError("BOOTSTRAP_PASSWORD debe tener al menos 12 caracteres");
    return {
        email,
        password,
        nombre: (env.BOOTSTRAP_NOMBRE ?? "").trim() || "Administrador de plataforma",
        empresa: (env.BOOTSTRAP_EMPRESA ?? "").trim() || "Plataforma",
    };
}

/**
 * Crea la empresa de plataforma y el maestro, en UNA transacción. `pool` es un pg.Pool.
 * @returns {Promise<{creado: boolean, motivo?: string, usuario_id?: number, empresa_id?: number}>}
 */
export async function crearMaestro(pool, entrada, { permitirOtro = false } = {}) {
    const hash = await bcrypt.hash(entrada.password, 12);
    const c = await pool.connect();
    try {
        await c.query("BEGIN");
        // Dos corridas a la vez no pueden crear dos maestros.
        await c.query("SELECT pg_advisory_xact_lock($1)", [CLAVE_DEL_CANDADO]);
        const propio = await c.query(
            "SELECT id, is_platform_admin FROM usuarios WHERE email = $1",
            [entrada.email],
        );
        if (propio.rowCount > 0) {
            await c.query("ROLLBACK");
            if (propio.rows[0].is_platform_admin) return { creado: false, motivo: "ya_es_maestro" };
            throw new BootstrapError(
                "Ese correo ya pertenece a un usuario común: no se le da el rol de maestro desde aquí",
                1,
            );
        }
        if (!permitirOtro) {
            const otro = await c.query("SELECT 1 FROM usuarios WHERE is_platform_admin LIMIT 1");
            if (otro.rowCount > 0) {
                await c.query("ROLLBACK");
                throw new BootstrapError(
                    "Ya existe un maestro de plataforma. Para crear otro a propósito usa --otro",
                    1,
                );
            }
        }
        const emp = await c.query("INSERT INTO empresas (nombre) VALUES ($1) RETURNING id", [
            entrada.empresa,
        ]);
        const u = await c.query(
            `INSERT INTO usuarios
                 (nombre, codigo_ingreso, email, password_hash, role_id, is_admin, is_owner, is_platform_admin, must_change_password, empresa_id)
             VALUES ($1, 'MAESTRO', $2, $3, 1, true, true, true, true, $4)
             RETURNING id`,
            [entrada.nombre, entrada.email, hash, emp.rows[0].id],
        );
        await c.query("COMMIT");
        return { creado: true, usuario_id: u.rows[0].id, empresa_id: emp.rows[0].id };
    } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
    } finally {
        c.release();
    }
}

async function main() {
    const { default: pool } = await import("../src/config/db.js");
    try {
        const r = await crearMaestro(pool, leerEntrada(process.env), {
            permitirOtro: process.argv.includes("--otro"),
        });
        console.log(
            r.creado
                ? `bootstrap:plataforma — maestro creado (usuario ${r.usuario_id}, empresa ${r.empresa_id}). Debe cambiar la contraseña temporal al entrar.`
                : "bootstrap:plataforma — ese correo ya es maestro: no se hizo nada.",
        );
    } catch (e) {
        console.error(`bootstrap:plataforma — ${e.message}`);
        process.exitCode = e instanceof BootstrapError ? e.codigo : 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
