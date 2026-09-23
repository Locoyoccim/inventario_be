#!/usr/bin/env node
/**
 * Diagnostica por qué un usuario no puede iniciar sesión.
 *
 *   node scripts/diagnosticar_login.js correo@dominio.com
 *   LOGIN_PASSWORD='la-clave' node scripts/diagnosticar_login.js correo@dominio.com
 *
 * Revisa .env, conexión a la BD, el registro del usuario (sin mostrar el hash),
 * si la contraseña coincide y, si el backend está corriendo, el flujo HTTP completo
 * (login -> cookie -> /me). No modifica nada.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const email = process.argv[2];
const password = process.env.LOGIN_PASSWORD ?? process.argv[3];
if (!email) {
    console.log("Uso: LOGIN_PASSWORD='clave' node scripts/diagnosticar_login.js correo@dominio.com");
    process.exit(1);
}

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const info = (m) => console.log(`  · ${m}`);
let problemas = 0;
const fail = (m) => { problemas++; bad(m); };

console.log("\n1) Configuración (.env)");
process.env.JWT_SECRET ? ok("JWT_SECRET definido") : fail("JWT_SECRET vacío: el login responde 500");
info(`NODE_ENV=${process.env.NODE_ENV || "(vacío = development)"}`);
if (process.env.NODE_ENV === "production" && !process.env.COOKIE_SECURE) {
    info("En production la cookie es Secure: en http://localhost el navegador la descarta (usa COOKIE_SECURE=false en local)");
}
if (process.env.COOKIE_SAMESITE) info(`COOKIE_SAMESITE=${process.env.COOKIE_SAMESITE}`);

console.log("\n2) Base de datos");
const { Pool } = pg;
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false })
    : new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });

try {
    await pool.query("SELECT 1");
    ok(`Conectado a ${process.env.DATABASE_URL ? "DATABASE_URL" : `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`}`);

    const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name IN ('email','password_hash')"
    );
    if (cols.rowCount < 2) fail("La tabla usuarios no tiene email/password_hash: falta aplicar migraciones (npm run migrate)");

    console.log("\n3) Usuario");
    const exacto = await pool.query("SELECT id FROM usuarios WHERE email = $1", [email.trim()]);
    const parecidos = await pool.query(
        `SELECT u.id, u.email, u.empresa_id, u.is_admin, u.is_owner, u.password_hash, e.id AS empresa_existe
         FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
         WHERE lower(trim(u.email)) = lower(trim($1)) ORDER BY u.id`,
        [email]
    );
    if (parecidos.rowCount === 0) {
        fail(`No existe ningún usuario con el correo "${email}"`);
        const todos = await pool.query("SELECT id, email FROM usuarios ORDER BY id LIMIT 20");
        info("Usuarios registrados: " + (todos.rows.map((r) => `#${r.id} ${r.email ?? "(sin email)"}`).join(", ") || "ninguno"));
    } else {
        if (exacto.rowCount === 0) info(`El correo está guardado como "${parecidos.rows[0].email}" (mayúsculas/espacios distintos). El backend corregido ya lo acepta.`);
        if (parecidos.rowCount > 1) fail(`Hay ${parecidos.rowCount} usuarios con ese correo (distinto uso de mayúsculas): ids ${parecidos.rows.map((r) => r.id).join(", ")}. Se usa el de id menor.`);
        const u = parecidos.rows[0];
        ok(`Usuario #${u.id}, empresa ${u.empresa_id}, admin=${u.is_admin}, owner=${u.is_owner}`);
        if (!u.empresa_existe) fail(`La empresa ${u.empresa_id} no existe en la tabla empresas`);

        const hash = u.password_hash;
        if (!hash) {
            fail("El usuario NO tiene contraseña (password_hash vacío). Créala con scripts/crear_admin.js");
        } else if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(hash)) {
            fail(`password_hash no es bcrypt (largo ${hash.length}). Probablemente se guardó la clave en texto plano; regénérala con scripts/crear_admin.js`);
        } else {
            ok("password_hash tiene formato bcrypt");
            if (password === undefined) info("Pasa LOGIN_PASSWORD para comprobar la contraseña");
            else if (await bcrypt.compare(password, hash)) ok("La contraseña COINCIDE");
            else fail("La contraseña NO coincide con la guardada");
        }
    }
} catch (e) {
    fail(`Error de BD: ${e.message}`);
} finally {
    await pool.end();
}

console.log("\n4) Backend HTTP");
const base = `http://localhost:${process.env.PORT || 4000}`;
try {
    const health = await fetch(`${base}/health`);
    health.ok ? ok(`${base} responde`) : fail(`${base}/health respondió ${health.status}`);
    if (password !== undefined) {
        const r = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            fail(`POST /api/auth/login -> ${r.status}: ${body.error ?? "sin mensaje"}`);
            if (r.status === 500) info("Error interno: el detalle está en la consola del backend (ej. JWT_SECRET no cargado). ¿Reiniciaste el backend tras actualizar?");
        } else {
            ok("POST /api/auth/login -> 200");
            const cookie = r.headers.get("set-cookie");
            if (!cookie?.includes("gh_session=")) {
                fail("El login no devolvió la cookie gh_session: el backend en ejecución es una versión anterior. Reinícialo.");
            } else {
                ok("Cookie gh_session recibida");
                const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie.split(";")[0] } });
                const meBody = await me.json().catch(() => ({}));
                me.ok && meBody.data?.nombre ? ok(`/api/auth/me con cookie -> ${meBody.data.nombre}`) : fail(`/api/auth/me con cookie -> ${me.status}`);
            }
        }
    }
} catch {
    fail(`No hay backend escuchando en ${base} (npm run dev)`);
}

console.log(problemas ? `\nSe encontraron ${problemas} problema(s).` : "\nTodo en orden: el login debería funcionar desde el front.");
process.exit(problemas ? 1 : 0);
