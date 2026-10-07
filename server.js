// Cargar .env ANTES que cualquier otro módulo: varios leen process.env al importarse
// (app.js: CORS_ORIGINS/NODE_ENV). Los imports ESM se evalúan en orden.
import "dotenv/config";
// Valida la configuración (secretos incluidos) antes de cargar la app y la base; aborta el arranque si es insegura.
import "./src/config/validar-env.js";
import app from "./src/app.js";
import pool from "./src/config/db.js";
import { cerrarEventos } from "./src/realtime/eventosPos.js";

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
    // Los flujos SSE no terminan solos: se cierran para que server.close() no espere.
    await cerrarEventos();
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
