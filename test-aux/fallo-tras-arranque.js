// (Fuera de test/ a propósito: `node --test` ejecuta como prueba todo .js/.mjs que haya dentro de una carpeta test.)
// Se precarga (node --import) delante de server.js: provoca una promesa rechazada sin catch con el servidor ya en marcha.
setTimeout(
    () => {
        Promise.reject(new Error("fallo-provocado-por-la-prueba"));
    },
    Number(process.env.FALLO_TRAS_MS ?? 2500),
);
