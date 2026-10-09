import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { rutaSegura } from "../utils/redactar.js";

// Un id entrante solo se acepta con una forma conocida: sin saltos de línea ni texto libre que ensucie o falsifique los logs.
const ID_VALIDO = /^[A-Za-z0-9._-]{8,64}$/;

/** Id de la petición: el que manda el cliente (o un proxy) si tiene forma válida; si no, uno nuevo. */
export function idDePeticion(entrante) {
    return typeof entrante === "string" && ID_VALIDO.test(entrante) ? entrante : randomUUID();
}

const nivelPorStatus = (status) => (status >= 500 ? "error" : status >= 400 ? "warn" : "info");

// Los monitores consultan /health y /health/ready cada minuto: si responden bien no aportan nada al log. Si fallan, sí se registran.
const ES_SALUD = /^\/health(\/|$)/;

// Asigna un id a cada petición (también en la cabecera de respuesta) y registra método, ruta, status, duración, quién y desde dónde.
export function requestLogger(req, res, next) {
    req.id = idDePeticion(req.get("x-request-id"));
    res.setHeader("X-Request-Id", req.id);
    const start = Date.now();
    res.on("finish", () => {
        if (res.statusCode < 400 && ES_SALUD.test(req.originalUrl.split("?")[0])) return;
        // La ruta se registra sin la query y con los tokens enmascarados (p. ej. el de una invitación): el log no guarda secretos.
        logger[nivelPorStatus(res.statusCode)]("request", {
            requestId: req.id,
            method: req.method,
            ...rutaSegura(req.originalUrl),
            status: res.statusCode,
            ms: Date.now() - start,
            // `req.user` lo pone la autenticación; en rutas públicas (login, salud) no hay nadie identificado.
            usuario_id: req.user?.id ?? null,
            empresa_id: req.user?.empresa_id ?? null,
            ip: req.ip,
        });
    });
    next();
}
export default requestLogger;
