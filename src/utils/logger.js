import { limpiarContexto, limpiarTexto } from "./redactar.js";

// Logger estructurado en JSON (una línea por evento). Todo lo que entra pasa por el saneador: aunque un llamador registre sin
// cuidado un error con un correo, un token o una contraseña, la línea que sale ya no los lleva (ver utils/redactar.js).
function write(level, message, ctx = {}) {
    // `ts`, `level` y `message` (el nombre del evento) son de la línea, no del contexto: si un llamador pasa un campo con ese nombre
    // (p. ej. `message: error.message`) no puede pisar el nombre del evento, que es por lo que se busca y se alerta. Se conserva como `detalle`.
    const { ts: _ts, level: _level, message: detalle, ...resto } = ctx;
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message: limpiarTexto(message),
        ...limpiarContexto(detalle !== undefined ? { detalle, ...resto } : resto),
    });
    if (level === "error") console.error(line);
    else console.log(line);
}
export const logger = {
    info: (m, c) => write("info", m, c),
    warn: (m, c) => write("warn", m, c),
    error: (m, c) => write("error", m, c),
};
export default logger;
