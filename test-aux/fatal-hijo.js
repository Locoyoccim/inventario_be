// Proceso hijo de prueba (fuera de test/ a propósito: `node --test` ejecuta como prueba todo .js/.mjs que haya dentro de una carpeta test): instala los manejadores REALES y provoca un fallo no capturado. No es una prueba (no termina en .test.js).
//   node fatal-hijo.js rechazo | excepcion | cierre-colgado | rechazo-no-error
import { crearManejadoresFatales } from "../src/utils/procesoFatal.js";

const escenario = process.argv[2];
const cerrar = escenario === "cierre-colgado" ? () => new Promise(() => {}) : async () => {};
crearManejadoresFatales({ cerrar, plazoMs: 400 }).instalar();

// Salvo en «cierre-colgado», se mantiene el proceso vivo para comprobar que lo termina el manejador. En «cierre-colgado» no queda
// NADA más vivo salvo el temporizador de cierre forzado: si ese temporizador no mantuviera vivo el proceso, saldría solo con código 0.
if (escenario !== "cierre-colgado") setInterval(() => {}, 1000);
setTimeout(() => {
    if (escenario === "excepcion") throw new Error("excepcion-de-prueba ana@correo.com");
    if (escenario === "rechazo-no-error") Promise.reject("texto-suelto-de-prueba");
    else Promise.reject(new Error("rechazo-de-prueba ana@correo.com"));
}, 50);
