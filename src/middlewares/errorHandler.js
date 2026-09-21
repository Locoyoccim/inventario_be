import ApiError from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";

// Mapeo de códigos de error de PostgreSQL a respuestas limpias (sin filtrar SQL).
const PG_ERRORS = {
    "23505": [409, "El registro ya existe (dato duplicado)"],
    "23503": [400, "Referencia inválida: el recurso relacionado no existe"],
    "23502": [400, "Falta un campo requerido"],
    "23514": [400, "Un valor no cumple una restricción de la base"],
    "22P02": [400, "Formato de dato inválido"],
    "22003": [400, "Un número está fuera de rango"],
};

// Middleware central de errores (debe ir DESPUÉS de las rutas).
export function errorHandler(err, req, res, _next) {
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({
            success: false,
            error: err.message,
            ...(err.details ? { details: err.details } : {}),
        });
    }

    if (err && err.name === "ZodError") {
        const issues = (err.issues || err.errors || []).map((i) => ({
            campo: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
            mensaje: i.message,
        }));
        return res.status(400).json({ success: false, error: "Validación fallida", details: issues });
    }

    if (err && err.code && PG_ERRORS[err.code]) {
        const [status, message] = PG_ERRORS[err.code];
        logger.warn("db_error", { requestId: req.id, code: err.code, detail: err.detail });
        return res.status(status).json({ success: false, error: message });
    }

    // Inesperado: se registra completo, al cliente solo un genérico.
    logger.error("unhandled_error", {
        requestId: req.id,
        message: err && err.message,
        stack: err && err.stack,
    });
    return res.status(500).json({ success: false, error: "Error interno del servidor" });
}
export default errorHandler;
