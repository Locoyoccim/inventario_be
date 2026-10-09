// Cargar .env ANTES que cualquier otro módulo: varios leen process.env al importarse
// (app.js: CORS_ORIGINS/NODE_ENV). Los imports ESM se evalúan en orden.
import "dotenv/config";
// Valida la configuración (secretos incluidos) antes de cargar la app y la base; aborta el arranque si es insegura.
import "./src/config/validar-env.js";
import app from "./src/app.js";
import pool from "./src/config/db.js";
import { cerrarEventos } from "./src/realtime/eventosPos.js";
import { verificarRolDeAplicacion } from "./src/config/rolDb.js";
import { crearManejadoresFatales } from "./src/utils/procesoFatal.js";
import { iniciarSentry, capturarError, vaciarSentry } from "./src/utils/sentry.js";

let server;

// Cierra lo que esté abierto, en orden: los flujos de avisos (SSE) no terminan solos y bloquearían server.close(); después la base.
async function cerrarTodo() {
    // Los eventos pendientes de Sentry salen en paralelo al cierre, con su propio tope (no alargan el plazo del cierre).
    const envioPendiente = vaciarSentry(1500);
    await cerrarEventos();
    if (server?.listening) await new Promise((resolver) => server.close(resolver));
    await pool.end().catch(() => {});
    await envioPendiente;
}

// Un error que nadie capturó (promesa rechazada sin catch o excepción suelta) deja el proceso en un estado desconocido: se registra
// y se cierra en orden para que el orquestador levante uno limpio. Se instala ANTES de arrancar para cubrir también el arranque.
crearManejadoresFatales({
    cerrar: cerrarTodo,
    reportar: (tipo, error) => capturarError(error, { tipo }),
}).instalar();

// Sentry solo se enciende si hay SENTRY_DSN (ver utils/sentry.js); nunca impide arrancar.
await iniciarSentry();

// La app no debe conectarse como superusuario ni como dueña de las tablas (aborta en producción; avisa en desarrollo).
await verificarRolDeAplicacion(pool);

const PORT = process.env.PORT || 4000;

server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Cierre ordenado ante SIGTERM/SIGINT: deja de aceptar conexiones, espera a las peticiones en curso (máximo 10s) y cierra la base.
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
    await cerrarTodo();
    clearTimeout(forzar);
    console.log("Servidor y base de datos cerrados correctamente.");
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
