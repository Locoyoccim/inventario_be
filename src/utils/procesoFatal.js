import logger from "./logger.js";

// Errores que nadie capturó (una promesa rechazada sin catch, una excepción fuera de cualquier try): el proceso queda en un estado
// que no podemos conocer —una conexión a medias, una transacción sin cerrar, datos a medio escribir—. Seguir vivo así es peor que
// reiniciar: se deja el error en el log (con su stack, saneado) y se cierra en orden; el orquestador (Railway) levanta un proceso limpio.

export const PLAZO_CIERRE_MS = 3000;

/**
 * @param {object}   o
 * @param {Function} o.cerrar   cierra lo que esté abierto (servidor, avisos, base); puede tardar o fallar
 * @param {Function} [o.salir]  termina el proceso con un código (inyectable en pruebas)
 * @param {number}   [o.plazoMs] tope para el cierre ordenado; pasado el plazo se sale igual
 * @param {Function} [o.reportar] recibe (tipo, error) para avisar a un servicio externo (Sentry); si falla se ignora
 * @param {object}   [o.log]    logger (inyectable en pruebas)
 * @returns {{ fatal: Function, instalar: Function }}
 */
export function crearManejadoresFatales({
    cerrar,
    salir = (codigo) => process.exit(codigo),
    plazoMs = PLAZO_CIERRE_MS,
    reportar = () => {},
    log = logger,
}) {
    let cerrando = false;

    // `error` puede no ser un Error (se puede rechazar una promesa con un texto, un objeto o nada).
    function fatal(tipo, error) {
        const esError = error instanceof Error;
        log.error(tipo, {
            error: esError ? error.message : String(error).slice(0, 500),
            stack: esError ? error.stack : undefined,
            plazo_cierre_ms: plazoMs,
        });
        try {
            reportar(tipo, error);
        } catch {
            /* un fallo al reportar nunca debe impedir el cierre */
        }
        // Un segundo error mientras se cierra: el estado ya es peor, no se espera más.
        if (cerrando) {
            log.error("fatal_repetido", { tipo });
            salir(1);
            return;
        }
        cerrando = true;
        // Sin unref: si el cierre se cuelga (nada más mantiene vivo el proceso) este temporizador es lo que lo termina.
        const forzar = setTimeout(() => {
            log.error("cierre_forzado", { plazo_ms: plazoMs });
            salir(1);
        }, plazoMs);
        Promise.resolve()
            .then(cerrar)
            .then(() => log.info("cierre_ordenado", { motivo: tipo }))
            .catch((e) => log.error("cierre_fallido", { error: e?.message ?? String(e) }))
            .finally(() => {
                clearTimeout(forzar);
                salir(1);
            });
    }

    /** Engancha los dos manejadores a un proceso (o a un emisor falso en las pruebas). */
    function instalar(proc = process) {
        proc.on("unhandledRejection", (razon) => fatal("unhandled_rejection", razon));
        proc.on("uncaughtException", (error) => fatal("uncaught_exception", error));
    }

    return { fatal, instalar };
}
