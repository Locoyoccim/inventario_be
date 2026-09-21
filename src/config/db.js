import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;

// Railway inyecta DATABASE_URL; en local usamos las variables DB_*.
const pool = process.env.DATABASE_URL
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
      })
    : new Pool({
          user: process.env.DB_USER,
          host: process.env.DB_HOST,
          database: process.env.DB_NAME,
          password: process.env.DB_PASSWORD,
          port: process.env.DB_PORT,
      });

// Prueba de conexión
pool.connect()
    .then((client) => {
        client.release();
        console.log("Conexión a la base de datos exitosa");
    })
    .catch((err) => {
        console.error("Error al conectar a la base de datos:", err.message);
    });

export default pool;
