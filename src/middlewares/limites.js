import rateLimit from "express-rate-limit";
import { registrarEvento } from "../utils/seguridad.js";
import { rutaSegura } from "../utils/redactar.js";

const VENTANA_MS = 60 * 1000;

// Durante un ataque cada petición bloqueada volvería a escribir el evento: se registra una vez por IP y límite en cada ventana.
const ultimoAviso = new Map();
function debeAvisar(clave, ahora = Date.now()) {
    const antes = ultimoAviso.get(clave);
    if (antes !== undefined && ahora - antes < VENTANA_MS) return false;
    ultimoAviso.set(clave, ahora);
    if (ultimoAviso.size > 1000) {
        for (const [k, t] of ultimoAviso) if (ahora - t >= VENTANA_MS) ultimoAviso.delete(k);
    }
    return true;
}

/**
 * Tope de peticiones por minuto y por IP. Al excederlo responde 429 con el mismo cuerpo de siempre y deja el evento `limite_excedido`
 * (qué límite, qué ruta y cuál era el tope). `nombre` identifica el límite en el log.
 */
export function crearLimite({ nombre, max, error, skip }) {
    return rateLimit({
        windowMs: VENTANA_MS,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip,
        handler: (req, res, _next, options) => {
            if (debeAvisar(`${nombre}|${req.ip}`)) {
                registrarEvento(req, "limite_excedido", {
                    limite: nombre,
                    max,
                    ruta: rutaSegura(req.originalUrl).path,
                    status: options.statusCode,
                });
            }
            res.status(options.statusCode).json({ success: false, error });
        },
    });
}
