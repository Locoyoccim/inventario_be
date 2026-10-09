import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "migrations");

// Las migraciones las corre el rol MIGRADOR (dueño de los objetos): MIGRATE_DATABASE_URL. Sin ella se usa la conexión normal
// (DATABASE_URL o DB_*) del .env, que solo sirve si ese rol es dueño de las tablas (desarrollo sin roles). Ver docs/DB_ROLES.md.
function makePool() {
    const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
    if (url) {
        return new Pool({
            connectionString: url,
            ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
        });
    }
    return new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });
}

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            filename TEXT UNIQUE NOT NULL,
            applied_at TIMESTAMP NOT NULL DEFAULT now()
        );`);
}

function migrationFiles() {
    if (!fs.existsSync(DIR)) return [];
    return fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
}

async function appliedSet(client) {
    const r = await client.query("SELECT filename FROM schema_migrations");
    return new Set(r.rows.map((x) => x.filename));
}

/**
 * Migra archivos antiguos que traen BEGIN/COMMIT en la primera/última sentencia.
 * PostgreSQL no admite transacciones anidadas: el runner es el único dueño de la transacción
 * para que los cambios de esquema y su fila en schema_migrations sean atómicos.
 * Conserva los archivos SQL heredados sin mutarlos.
 */
export function normalizarSqlMigracion(sql) {
    const lineas = sql.split(/\r?\n/);
    const esComentarioOVacio = (linea) => linea.trim() === "" || linea.trim().startsWith("--");
    const primero = lineas.findIndex((linea) => !esComentarioOVacio(linea));
    if (primero !== -1 && /^BEGIN\s*;\s*(?:--.*)?$/i.test(lineas[primero].trim())) {
        lineas.splice(primero, 1);
    }

    let ultimo = lineas.length - 1;
    while (ultimo >= 0 && esComentarioOVacio(lineas[ultimo])) ultimo -= 1;
    if (ultimo >= 0 && /^COMMIT\s*;\s*(?:--.*)?$/i.test(lineas[ultimo].trim())) {
        lineas.splice(ultimo, 1);
    }
    return lineas.join("\n").trim();
}

/**
 * Ejecuta una migración y registra su aplicación en una única transacción.
 * Si el SQL o el INSERT en schema_migrations fallan, revierte también los cambios de esquema.
 */
export async function aplicarMigracion(client, filename, sql) {
    let transaccionAbierta = false;
    try {
        await client.query("BEGIN");
        transaccionAbierta = true;
        await client.query(normalizarSqlMigracion(sql));
        // Un dump de pg_dump (001_baseline) deja search_path='' en la sesión: restaurarlo
        // para que el INSERT y las migraciones siguientes encuentren sus tablas.
        await client.query("RESET search_path");
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        transaccionAbierta = false;
    } catch (error) {
        if (transaccionAbierta) {
            try {
                await client.query("ROLLBACK");
            } catch {
                // Preserva el error original; no lo sustituye si la conexión ya perdió su transacción.
            }
        }
        throw error;
    }
}

async function run() {
    const pool = makePool();
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const done = await appliedSet(client);
        const pend = migrationFiles().filter((f) => !done.has(f));
        if (pend.length === 0) {
            console.log("Sin migraciones pendientes.");
            return;
        }
        for (const f of pend) {
            const sql = fs.readFileSync(path.join(DIR, f), "utf8");
            console.log("Aplicando", f, "...");
            try {
                await aplicarMigracion(client, f, sql);
                console.log("  OK", f);
            } catch (e) {
                console.error("  FALLÓ", f, "->", e.message);
                throw e;
            }
        }
    } finally {
        client.release();
        await pool.end();
    }
}

async function mark(f) {
    const pool = makePool();
    const client = await pool.connect();
    try {
        await ensureTable(client);
        await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
            [f],
        );
        console.log("Marcada como aplicada (sin ejecutar):", f);
    } finally {
        client.release();
        await pool.end();
    }
}

async function status() {
    const pool = makePool();
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const done = await appliedSet(client);
        const all = migrationFiles();
        if (all.length === 0) console.log("(no hay archivos en db/migrations)");
        for (const f of all) console.log((done.has(f) ? "[x] " : "[ ] ") + f);
    } finally {
        client.release();
        await pool.end();
    }
}

// Permite importar las funciones de transacción en pruebas sin ejecutar el CLI como efecto secundario.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [cmd, arg] = process.argv.slice(2);
    try {
        if (cmd === "mark") {
            if (!arg) {
                console.error("uso: node db/migrate.js mark <archivo.sql>");
                process.exit(1);
            }
            await mark(arg);
        } else if (cmd === "status") {
            await status();
        } else {
            await run();
        }
    } catch (e) {
        console.error("Error de migración:", e.message);
        // 42501 = privilegios insuficientes: casi siempre es correr las migraciones con el rol de la app en vez del migrador.
        if (e.code === "42501" || /must be owner|permission denied/i.test(e.message)) {
            console.error(
                "Pista: las migraciones necesitan el rol migrador. Define MIGRATE_DATABASE_URL (ver docs/DB_ROLES.md).",
            );
        }
        process.exit(1);
    }
}
