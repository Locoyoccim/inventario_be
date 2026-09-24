import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;

// Blindaje del pool: tope de conexiones, cierre de inactivas, y timeouts para que una
// query o una conexión colgada no bloqueen el proceso.
const POOL_OPTS = {
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
};

// Railway inyecta DATABASE_URL; en local usamos las variables DB_*.
const pool = process.env.DATABASE_URL
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
          ...POOL_OPTS,
      })
    : new Pool({
          user: process.env.DB_USER,
          host: process.env.DB_HOST,
          database: process.env.DB_NAME,
          password: process.env.DB_PASSWORD,
          port: process.env.DB_PORT,
          ...POOL_OPTS,
      });

// Un cliente inactivo puede fallar (corte de red, reinicio de Postgres). Sin este
// manejador, ese error emitido por el pool tumbaría el proceso.
pool.on("error", (err) => {
    console.error("Error inesperado en cliente inactivo del pool:", err.message);
});

// Prueba de conexión (se omite en pruebas: no queremos abrir conexiones ni ruido en node:test)
if (process.env.NODE_ENV !== "test") {
    pool.connect()
        .then((client) => {
            client.release();
            console.log("Conexión a la base de datos exitosa");
        })
        .catch((err) => {
            console.error("Error al conectar a la base de datos:", err.message);
        });
}

export default pool;
