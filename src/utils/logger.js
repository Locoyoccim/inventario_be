import { limpiarContexto, limpiarTexto } from "./redactar.js";

// Logger estructurado en JSON (una línea por evento). Todo lo que entra pasa por el saneador: aunque un llamador registre sin
// cuidado un error con un correo, un token o una contraseña, la línea que sale ya no los lleva (ver utils/redactar.js).
function write(level, message, ctx = {}) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message: limpiarTexto(message),
        ...limpiarContexto(ctx),
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
