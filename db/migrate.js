import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "migrations");

function makePool() {
    if (process.env.DATABASE_URL) {
        return new Pool({
            connectionString: process.env.DATABASE_URL,
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
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function appliedSet(client) {
    const r = await client.query("SELECT filename FROM schema_migrations");
    return new Set(r.rows.map((x) => x.filename));
}

async function run() {
    const pool = makePool();
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const done = await appliedSet(client);
        const pend = migrationFiles().filter((f) => !done.has(f));
        if (pend.length === 0) { console.log("Sin migraciones pendientes."); return; }
        for (const f of pend) {
            const sql = fs.readFileSync(path.join(DIR, f), "utf8");
            console.log("Aplicando", f, "...");
            try {
                await client.query("BEGIN");
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [f]);
                await client.query("COMMIT");
                console.log("  OK", f);
            } catch (e) {
                await client.query("ROLLBACK");
                console.error("  FALLÓ", f, "->", e.message);
                throw e;
            }
        }
    } finally { client.release(); await pool.end(); }
}

async function mark(f) {
    const pool = makePool();
    const client = await pool.connect();
    try {
        await ensureTable(client);
        await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
            [f]
        );
        console.log("Marcada como aplicada (sin ejecutar):", f);
    } finally { client.release(); await pool.end(); }
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
    } finally { client.release(); await pool.end(); }
}

const [cmd, arg] = process.argv.slice(2);
try {
    if (cmd === "mark") {
        if (!arg) { console.error("uso: node db/migrate.js mark <archivo.sql>"); process.exit(1); }
        await mark(arg);
    } else if (cmd === "status") {
        await status();
    } else {
        await run();
    }
} catch (e) {
    console.error("Error de migración:", e.message);
    process.exit(1);
}
