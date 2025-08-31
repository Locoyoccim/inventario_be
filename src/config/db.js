import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pg;

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Prueba de conexión
pool.connect()
    .then(() => console.log("Conexión a la base de datos exitosa"))
    .catch((err) => {
        console.error("Error al conectar a la base de datos:", err.message);
        console.error("Detalles del error:", err);
        console.error(
            "Verifica que la base de datos exista, las credenciales sean correctas y el servidor esté en ejecución."
        );
    });

export default pool;
