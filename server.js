// Cargar .env ANTES que cualquier otro módulo: varios leen process.env al importarse
// (app.js: CORS_ORIGINS/NODE_ENV). Los imports ESM se evalúan en orden.
import "dotenv/config";
import { validateEnv } from "./src/config/env.js";
import app from "./src/app.js";
import pool from "./src/config/db.js";

// Aborta el arranque si la configuración crítica no es válida.
validateEnv();

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Cierre ordenado: deja de aceptar conexiones, espera a las peticiones en curso
// (máximo 10s) y cierra el pool de la base.
let cerrando = false;
async function shutdown(signal) {
    if (cerrando) return;
    cerrando = true;
    console.log(`\n${signal} recibido: cerrando servidor...`);
    const forzar = setTimeout(() => {
        console.error("Cierre forzado tras 10s.");
        process.exit(1);
    }, 10000);
    forzar.unref();
    server.close(async () => {
        try {
            await pool.end();
        } catch {
            /* noop */
        }
        clearTimeout(forzar);
        console.log("Servidor y base de datos cerrados correctamente.");
        process.exit(0);
    });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
