#!/usr/bin/env node
// Respaldo y restauración de la base de datos (PostgreSQL) con pg_dump / pg_restore.
//
//   npm run backup                       Crea backups/<base>-AAAAMMDD-HHMMSS.dump, la comprueba y rota las antiguas
//   npm run backup:verify [archivo]      Restaura el respaldo en una base TEMPORAL y compara conteos (prueba real)
//   npm run backup:restore -- <archivo> <base_nueva>   Restaura en una base NUEVA (nunca sobrescribe la actual)
//
// Variables (además de las de conexión de .env): BACKUP_DIR (def. ./backups), BACKUP_KEEP (def. 14 copias),
// BACKUP_UPLOAD_CMD (opcional, comando que sube la copia a otro lugar; {file} se sustituye por la ruta).
// La contraseña viaja por PGPASSWORD, no por la línea de comandos.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.resolve(RAIZ, process.env.BACKUP_DIR || "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
// Tablas cuyo conteo debe coincidir entre la base y su respaldo restaurado.
const TABLAS_CLAVE = ["empresas", "usuarios", "productos", "recetas", "movimientosinventario", "ingresos", "pos_cuentas", "pos_pagos"];

function conexion() {
    if (process.env.DATABASE_URL) {
        const u = new URL(process.env.DATABASE_URL);
        return {
            host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
            database: u.pathname.replace(/^\//, ""), ssl: process.env.DB_SSL === "require",
        };
    }
    return {
        host: process.env.DB_HOST || "127.0.0.1", port: process.env.DB_PORT || "5432", user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME, ssl: process.env.DB_SSL === "require",
    };
}

const envPg = (c, database = c.database) => ({
    ...process.env, PGHOST: c.host, PGPORT: String(c.port), PGUSER: c.user, PGPASSWORD: c.password, PGDATABASE: database,
    ...(c.ssl ? { PGSSLMODE: "require" } : {}),
});

function ejecutar(cmd, args, env) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { env, stdio: ["ignore", "inherit", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => { err += d; });
        p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? `No se encontró «${cmd}». Instala las herramientas cliente de PostgreSQL (pg_dump/pg_restore).` : e.message)));
        p.on("close", (code) => {
            if (code === 0) return resolve(err);
            const e = new Error(`${cmd} terminó con código ${code}: ${err.trim().slice(-600)}`);
            e.stderr = err; // completo, para clasificar los errores
            reject(e);
        });
    });
}

const sello = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function respaldos() {
    if (!fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".dump")).sort().map((f) => path.join(DIR, f));
}

async function respaldar() {
    const c = conexion();
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const archivo = path.join(DIR, `${c.database}-${sello()}.dump`);
    console.log(`Respaldando «${c.database}» en ${c.host}...`);
    // Formato custom (comprimido, restaurable por partes). Sin dueños/permisos: se restaura en cualquier servidor.
    await ejecutar("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", archivo], envPg(c));
    fs.chmodSync(archivo, 0o600);
    // Un respaldo que no se puede leer no sirve: se comprueba el índice del archivo.
    const lista = spawnSync("pg_restore", ["--list", archivo], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (lista.status !== 0 || !lista.stdout.includes("TABLE DATA")) {
        fs.rmSync(archivo, { force: true });
        throw new Error("El respaldo se generó pero no es legible; se descartó. Revisa la conexión y la versión de pg_dump.");
    }
    console.log(`OK  ${archivo}  (${mb(fs.statSync(archivo).size)})`);

    const todos = respaldos();
    for (const viejo of todos.slice(0, Math.max(0, todos.length - KEEP))) {
        fs.rmSync(viejo, { force: true });
        console.log(`Rotado: ${path.basename(viejo)} (se conservan las últimas ${KEEP})`);
    }
    if (process.env.BACKUP_UPLOAD_CMD) {
        console.log("Subiendo copia fuera de este equipo...");
        const r = spawnSync(process.env.BACKUP_UPLOAD_CMD.replaceAll("{file}", JSON.stringify(archivo)), { shell: true, stdio: "inherit" });
        if (r.status !== 0) throw new Error("BACKUP_UPLOAD_CMD falló: la copia local existe pero NO se subió.");
    } else {
        console.log("Aviso: la copia solo está en este equipo. Configura BACKUP_UPLOAD_CMD para guardarla fuera (ver docs/RESPALDOS.md).");
    }
    return archivo;
}

async function conAdmin(c, fn) {
    // Base de mantenimiento «postgres» para crear/borrar bases temporales.
    const cli = new pg.Client({ host: c.host, port: Number(c.port), user: c.user, password: c.password, database: "postgres", ssl: c.ssl ? { rejectUnauthorized: false } : false });
    await cli.connect();
    try { return await fn(cli); } finally { await cli.end(); }
}

const ident = (nombre) => {
    if (!/^[a-z0-9_]{1,50}$/.test(nombre)) throw new Error("Nombre de base inválido: usa minúsculas, números y guion bajo.");
    return `"${nombre}"`;
};

async function restaurarEn(c, archivo, base) {
    await conAdmin(c, async (cli) => {
        const existe = await cli.query("SELECT 1 FROM pg_database WHERE datname = $1", [base]);
        if (existe.rowCount > 0) throw new Error(`La base «${base}» ya existe. Elige otro nombre: este comando nunca sobrescribe.`);
        await cli.query(`CREATE DATABASE ${ident(base)}`);
    });
    // Sin --exit-on-error: un pg_dump más nuevo que el servidor escribe SET de parámetros que este no conoce
    // (p. ej. transaction_timeout, de PostgreSQL 17). Esos avisos son inofensivos; cualquier otro error aborta.
    let err;
    try {
        err = await ejecutar("pg_restore", ["--no-owner", "--no-acl", "--dbname", base, archivo], envPg(c, base));
    } catch (e) {
        err = e.stderr ?? "";
        if (!/pg_restore: error:/.test(err)) throw e;
    }
    const graves = err.split("\n").filter((l) => l.startsWith("pg_restore: error:") && !l.includes("unrecognized configuration parameter"));
    if (graves.length > 0) throw new Error(`La restauración tuvo errores:\n${graves.slice(0, 5).join("\n")}`);
}

async function conteos(c, base) {
    const cli = new pg.Client({ host: c.host, port: Number(c.port), user: c.user, password: c.password, database: base, ssl: c.ssl ? { rejectUnauthorized: false } : false });
    await cli.connect();
    try {
        const out = {};
        for (const t of TABLAS_CLAVE) out[t] = Number((await cli.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
        out.migraciones = Number((await cli.query("SELECT COUNT(*) AS n FROM schema_migrations")).rows[0].n);
        return out;
    } finally { await cli.end(); }
}

async function verificar(archivo) {
    const c = conexion();
    archivo = archivo ? path.resolve(archivo) : respaldos().at(-1);
    if (!archivo || !fs.existsSync(archivo)) throw new Error("No hay respaldos para verificar. Ejecuta primero: npm run backup");
    const temporal = `respaldo_verif_${Date.now()}`;
    console.log(`Verificando ${path.basename(archivo)} en la base temporal «${temporal}»...`);
    try {
        await restaurarEn(c, archivo, temporal);
        const [origen, copia] = [await conteos(c, c.database), await conteos(c, temporal)];
        let difiere = false;
        for (const [tabla, n] of Object.entries(origen)) {
            // Una diferencia pequeña es normal si la base siguió operando después del respaldo; se muestra siempre.
            const marca = n === copia[tabla] ? "=" : "≠";
            if (n !== copia[tabla]) difiere = true;
            console.log(`  ${marca} ${tabla.padEnd(24)} base: ${String(n).padStart(7)}   respaldo: ${String(copia[tabla]).padStart(7)}`);
        }
        console.log(difiere ? "OK: el respaldo se restauró. Hay diferencias de conteo (¿la base siguió operando después del respaldo?)." : "OK: el respaldo se restauró y coincide con la base actual.");
    } finally {
        await conAdmin(c, (cli) => cli.query(`DROP DATABASE IF EXISTS ${ident(temporal)}`)).catch(() => console.warn(`No se pudo borrar la base temporal ${temporal}; elimínala a mano.`));
    }
}

async function restaurar(archivo, base) {
    if (!archivo || !base) throw new Error("Uso: npm run backup:restore -- <archivo.dump> <nombre_base_nueva>");
    const c = conexion();
    if (base === c.database) throw new Error("Por seguridad no se restaura sobre la base en uso. Elige un nombre nuevo y apunta DB_NAME/DATABASE_URL a ella cuando la hayas revisado.");
    console.log(`Restaurando ${path.basename(archivo)} en la base nueva «${base}»...`);
    await restaurarEn(c, path.resolve(archivo), base);
    console.log(`OK. Revisa la base «${base}»; para usarla cambia DB_NAME (o DATABASE_URL) y reinicia el servidor.`);
}

const [accion = "respaldar", a, b] = process.argv.slice(2);
try {
    if (accion === "respaldar" || accion === "backup") await respaldar();
    else if (accion === "verificar" || accion === "verify") await verificar(a);
    else if (accion === "restaurar" || accion === "restore") await restaurar(a, b);
    else throw new Error(`Acción desconocida «${accion}». Usa: respaldar | verificar | restaurar`);
} catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
}
