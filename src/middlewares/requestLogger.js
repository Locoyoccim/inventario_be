import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";

// Asigna un id a cada request y registra método, ruta, status y duración.
export function requestLogger(req, res, next) {
    req.id = randomUUID();
    const start = Date.now();
    res.on("finish", () => {
        logger.info("request", {
            requestId: req.id,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            ms: Date.now() - start,
        });
    });
    next();
}
export default requestLogger;
