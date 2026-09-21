// Logger estructurado en JSON (una línea por evento).
function write(level, message, ctx = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...ctx });
    if (level === "error") console.error(line);
    else console.log(line);
}
export const logger = {
    info: (m, c) => write("info", m, c),
    warn: (m, c) => write("warn", m, c),
    error: (m, c) => write("error", m, c),
};
export default logger;
