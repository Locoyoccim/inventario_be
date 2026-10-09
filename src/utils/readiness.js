import logger from "./logger.js";

// Readiness (/health/ready): ¿la base responde? Un monitor lo consulta cada minuto o menos; escribir un log por consulta fallida
// llenaría el log justo cuando más hace falta leerlo. Aquí solo se registran las TRANSICIONES (cayó, sigue caída cada 5 min, se
// recuperó) y el log queda con lo que importa: cuándo empezó, cuánto duró y por qué.

export const TIMEOUT_READINESS_MS = 5000; // la conexión ya tiene 5 s de tope en db.js; una consulta ya abierta podría tardar 15
export const RECORDATORIO_MS = 5 * 60 * 1000;

const texto = (error) =>
    (error instanceof Error ? error.message : String(error ?? "desconocido")).slice(0, 300);

export function crearVigilanteReadiness({
    log = logger,
    ahora = () => Date.now(),
    recordatorioMs = RECORDATORIO_MS,
} = {}) {
    let estado = "desconocido"; // "listo" | "caido"
    let desde = null;
    let ultimoAviso = null;
    let fallos = 0;

    return {
        /** Anota el resultado de UNA comprobación. `error` solo importa cuando `ok` es false. */
        observar(ok, error) {
            if (ok) {
                if (estado === "caido") {
                    log.info("readiness_recuperada", {
                        caida_ms: ahora() - desde,
                        fallos_consecutivos: fallos,
                    });
                }
                estado = "listo";
                desde = ultimoAviso = null;
                fallos = 0;
                return;
            }
            fallos++;
            if (estado !== "caido") {
                estado = "caido";
                desde = ultimoAviso = ahora();
                log.error("readiness_caida", { error: texto(error) });
                return;
            }
            if (ahora() - ultimoAviso >= recordatorioMs) {
                ultimoAviso = ahora();
                log.error("readiness_sigue_caida", {
                    caida_ms: ahora() - desde,
                    fallos_consecutivos: fallos,
                    error: texto(error),
                });
            }
        },
        /** Para pruebas y diagnóstico. */
        estado: () => ({ estado, desde, fallos }),
    };
}

/** Resuelve con la promesa, o rechaza si pasan `ms` (y limpia el temporizador: no deja el proceso colgado). */
export function conTimeout(promesa, ms) {
    let reloj;
    const limite = new Promise((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error(`la base no respondió en ${ms} ms`)), ms);
    });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

/**
 * Manejador Express de /health/ready. La respuesta no cambia (200 `ready` / 503 `unavailable`, sin detalle del error): lo nuevo es
 * que cada comprobación alimenta al vigilante.
 */
export function manejadorReadiness({
    consulta,
    vigilante = crearVigilanteReadiness(),
    timeoutMs = TIMEOUT_READINESS_MS,
}) {
    return async (_req, res) => {
        try {
            await conTimeout(Promise.resolve().then(consulta), timeoutMs);
            vigilante.observar(true);
            res.json({ status: "ready", ts: new Date().toISOString() });
        } catch (error) {
            vigilante.observar(false, error);
            res.status(503).json({ status: "unavailable" });
        }
    };
}
