import logger from "./logger.js";
import { limpiarContexto, limpiarTexto } from "./redactar.js";

// Sentry (opción «A»): listo pero APAGADO. Sin `SENTRY_DSN` este módulo no hace nada y el paquete ni siquiera se carga. Con DSN solo
// recibe los errores 500 inesperados y los fallos fatales del proceso (lo que ya se ve en el log como `unhandled_error`,
// `unhandled_rejection` y `uncaught_exception`), nunca peticiones ni datos de personas:
//   · sin integraciones por defecto (nada de breadcrumbs, variables locales, líneas de código fuente ni instrumentación HTTP);
//   · todo el contexto personal del SDK apagado (usuario, cookies, cabeceras, cuerpos, parámetros de la URL);
//   · `beforeSend` sanea lo que aún pudiera colarse (mismo saneador que el log: correos, tokens, credenciales en URL).

const NOMBRE_SERVIDOR = "api";
let sdk = null; // el módulo de Sentry, solo cuando está activo

/** Quita de un evento de Sentry todo lo que no debe salir de nuestro servidor. Función pura (se prueba sin red). */
export function limpiarEvento(evento, directorio = process.cwd()) {
    const limpio = { ...evento };
    // El nombre de la máquina no se envía (en desarrollo es el de la persona; en producción, un id de contenedor sin valor).
    if ("server_name" in limpio) limpio.server_name = NOMBRE_SERVIDOR;
    // Datos de la petición y de la persona: ni uno.
    delete limpio.request;
    delete limpio.user;
    delete limpio.breadcrumbs;
    if (limpio.message !== undefined) limpio.message = limpiarTexto(limpio.message);
    if (limpio.exception?.values) {
        limpio.exception = {
            ...limpio.exception,
            values: limpio.exception.values.map((v) => ({
                ...v,
                value: v.value === undefined ? v.value : limpiarTexto(v.value),
                // Rutas relativas al proyecto: sin el directorio del usuario o del contenedor, y los errores agrupan igual en todas partes.
                ...(v.stacktrace?.frames
                    ? {
                          stacktrace: {
                              ...v.stacktrace,
                              frames: v.stacktrace.frames.map((f) =>
                                  typeof f.filename === "string" &&
                                  f.filename.startsWith(directorio)
                                      ? {
                                            ...f,
                                            filename: f.filename
                                                .slice(directorio.length)
                                                .replace(/^[/\\]/, ""),
                                        }
                                      : f,
                              ),
                          },
                      }
                    : {}),
            })),
        };
    }
    for (const campo of ["extra", "contexts", "tags"]) {
        if (limpio[campo]) limpio[campo] = limpiarContexto(limpio[campo]);
    }
    return limpio;
}

/** Opciones de `Sentry.init`: todo apagado salvo el envío de errores que pedimos nosotros. */
export function opcionesSentry(env = process.env) {
    return {
        dsn: env.SENTRY_DSN.trim(),
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || "production",
        release: env.SENTRY_RELEASE || env.RAILWAY_GIT_COMMIT_SHA || undefined,
        serverName: NOMBRE_SERVIDOR,
        defaultIntegrations: false,
        integrations: [],
        // v11: cada categoría de datos del SDK se apaga por separado (por defecto casi todas están encendidas).
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
        },
        beforeSend: (evento) => limpiarEvento(evento),
    };
}

/**
 * Enciende Sentry si hay `SENTRY_DSN`. Nunca lanza: un fallo de Sentry no debe impedir arrancar el servidor.
 * @returns {Promise<boolean>} true si quedó activo
 */
export async function iniciarSentry({
    env = process.env,
    importar = () => import("@sentry/node"),
    log = logger,
} = {}) {
    if (!env.SENTRY_DSN?.trim()) return false;
    try {
        const modulo = await importar();
        const opciones = opcionesSentry(env);
        modulo.init(opciones);
        // Con un DSN mal escrito el SDK no lanza: crea un cliente desactivado y avisa por su cuenta. No se puede decir «activo» así.
        if (typeof modulo.isEnabled === "function" && !modulo.isEnabled()) {
            throw new Error("el SDK no quedó habilitado (¿SENTRY_DSN mal escrito?)");
        }
        sdk = modulo;
        log.info("sentry_activo", { environment: opciones.environment });
        return true;
    } catch (error) {
        log.error("sentry_no_inicia", { error: error?.message ?? String(error) });
        return false;
    }
}

/** Envía un error a Sentry (si está activo). `contexto` solo admite datos sin personas: tipo, requestId, ids numéricos. */
export function capturarError(error, contexto = {}) {
    if (!sdk) return;
    try {
        sdk.withScope((scope) => {
            for (const [clave, valor] of Object.entries(contexto)) {
                if (valor !== undefined && valor !== null)
                    scope.setTag(clave, String(valor).slice(0, 100));
            }
            sdk.captureException(
                error instanceof Error ? error : new Error(String(error).slice(0, 500)),
            );
        });
    } catch (e) {
        logger.warn("sentry_captura_fallida", { error: e?.message ?? String(e) });
    }
}

/** Espera (hasta `ms`) a que los eventos pendientes salgan. Nunca lanza ni espera más de lo indicado. */
export async function vaciarSentry(ms = 1500) {
    if (!sdk) return false;
    try {
        return await sdk.flush(ms);
    } catch {
        return false;
    }
}

/** Solo para pruebas: deja el módulo como si nunca se hubiera iniciado. */
export function reiniciarSentryParaPruebas() {
    sdk = null;
}

export const sentryActivo = () => sdk !== null;
