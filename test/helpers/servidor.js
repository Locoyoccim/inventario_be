/**
 * Arranque del servidor HTTP de las pruebas de integración.
 *
 * Se enlaza SIEMPRE a 127.0.0.1 (no al comodín `::`): las pruebas hacen `fetch` a 127.0.0.1:<puerto>, y con el comodín el sistema
 * puede asignar un puerto en el que OTRO proceso ya escucha solo en 127.0.0.1; la petición llegaba entonces a ese proceso y la prueba
 * fallaba (o pasaba) por razones ajenas. Con la dirección explícita, un puerto ocupado da EADDRINUSE: un error ruidoso y claro.
 */
export const HOST_PRUEBAS = "127.0.0.1";

/**
 * @param {import("node:http").RequestListener} app  aplicación Express
 * @param {{ puerto?: number }} [opciones]  `puerto` 0 (por defecto) = que el sistema elija uno libre en 127.0.0.1
 * @returns {Promise<{ server: import("node:http").Server, base: string }>}
 */
export function iniciarServidor(app, { puerto = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(puerto, HOST_PRUEBAS);
        server.once("error", (err) => {
            const quien = puerto === 0 ? "un puerto libre" : `el puerto ${puerto}`;
            const e = new Error(`No se pudo iniciar el servidor de pruebas en ${HOST_PRUEBAS} (${quien}): ${err.code ?? err.message}`, { cause: err });
            e.code = err.code;
            reject(e);
        });
        server.once("listening", () => {
            server.removeAllListeners("error");
            resolve({ server, base: `http://${HOST_PRUEBAS}:${server.address().port}` });
        });
    });
}
