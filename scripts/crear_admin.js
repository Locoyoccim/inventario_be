#!/usr/bin/env node
/**
 * Crea (o actualiza) un usuario con correo + contraseña para poder iniciar sesión.
 * Necesario para el primer login, porque crear usuarios por API ya requiere token.
 * Edita las variables de abajo y corre: node scripts/crear_admin.js
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
dotenv.config();

// ------- EDITA ESTO -------
const EMPRESA_ID = 4;
const NOMBRE = "Carlos Ramirez";
const EMAIL = "carlos@cafearoma.com";
const PASSWORD = "cambia_esta_clave";
const CODIGO_INGRESO = "CR001";
const PUESTO = "Dueño";
const ROLE_ID = 1;      // debe existir en la tabla roles
const IS_OWNER = true;
const IS_ADMIN = true;
// --------------------------

const { Pool } = pg;
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false })
    : new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });

const hash = await bcrypt.hash(PASSWORD, 10);
const sql = `
    INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, password_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (email) WHERE email IS NOT NULL
    DO UPDATE SET password_hash = EXCLUDED.password_hash, nombre = EXCLUDED.nombre
    RETURNING id, nombre, email, empresa_id, is_owner, is_admin;
`;
try {
    const r = await pool.query(sql, [NOMBRE, CODIGO_INGRESO, PUESTO, IS_ADMIN, IS_OWNER, ROLE_ID, EMPRESA_ID, EMAIL, hash]);
    console.log("Usuario listo para login:", r.rows[0]);
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
} finally {
    await pool.end();
}
