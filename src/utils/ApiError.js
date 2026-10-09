// Error controlado de la aplicación. El middleware de errores lo traduce a HTTP.
export default class ApiError extends Error {
    constructor(statusCode, message, details = null) {
        super(message);
        this.name = "ApiError";
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
    }
    // Marca el error como evento de seguridad: el manejador de errores lo registra (con ip, usuario y empresa de la petición).
    conEvento(evento, datos = {}) {
        this.evento = evento;
        this.eventoDatos = datos;
        return this;
    }
    static badRequest(msg, details = null) {
        return new ApiError(400, msg, details);
    }
    static unauthorized(msg = "No autorizado") {
        return new ApiError(401, msg);
    }
    static forbidden(msg = "Sin permisos") {
        return new ApiError(403, msg);
    }
    static notFound(msg = "Recurso no encontrado") {
        return new ApiError(404, msg);
    }
    static conflict(msg, details = null) {
        return new ApiError(409, msg, details);
    }
    static tooMany(msg, details = null) {
        return new ApiError(429, msg, details);
    }
}
