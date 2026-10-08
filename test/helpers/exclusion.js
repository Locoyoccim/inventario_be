/**
 * Exclusión entre archivos de prueba que comparten la MISMA base de datos.
 *
 * `node --test` corre cada archivo en su propio proceso y en paralelo, todos contra la misma base. Las pruebas de aislamiento
 * miden la «huella» de los datos de una empresa antes y después de un ataque y exigen que no cambie. Otro archivo que
 * ejecute una sentencia GLOBAL en ese instante (re-ejecutar una migración que recorre todas las empresas, apagar un trigger,
 * crear una tabla de sonda) cambia esa huella sin que ninguna ruta de la API lo haya hecho: un falso «B modificó datos de A»
 * que además solo aparece de vez en cuando (en CI ~1 de cada 4 corridas).
 *
 * Solución: un candado consultivo de Postgres (advisory lock) compartido por todos los procesos.
 *   · COMPARTIDO: lo toman las pruebas que miden huellas; cualquier número de ellas corre a la vez.
 *   · EXCLUSIVO: lo toma cualquier prueba que ejecute algo global; espera a que no haya ninguna midiendo y, mientras lo tiene,
 *     nadie empieza a medir.
 * El candado vive en una conexión propia y se suelta al cerrarla (también si el proceso muere). La regla «quien lo necesita lo
 * toma» la hace cumplir test/exclusion-pruebas.test.js (sin base de datos).
 */
import pg from "pg";

const CLAVE = 7240517; // número arbitrario, propio de este repositorio
const ESPERA_MAX_MS = 5 * 60 * 1000; // falla en voz alta en lugar de colgarse si alguien no suelta el candado

async function tomar(funcion) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("exclusion.js: falta TEST_DATABASE_URL");
    const cliente = new pg.Client({ connectionString: url });
    await cliente.connect();
    try {
        await cliente.query(`SET statement_timeout = ${ESPERA_MAX_MS}`);
        await cliente.query(`SELECT ${funcion}($1)`, [CLAVE]);
    } catch (e) {
        await cliente.end().catch(() => {});
        throw e;
    }
    let suelto = false;
    return {
        async liberar() {
            if (suelto) return;
            suelto = true;
            await cliente.end(); // cerrar la sesión suelta el candado
        },
    };
}

/** Para pruebas que miden la huella de una empresa. Devuelve `{ liberar() }`; llámalo en `after`. */
export const tomarCompartido = () => tomar("pg_advisory_lock_shared");

/** Para pruebas que ejecutan algo global (migración, DDL, trigger). Devuelve `{ liberar() }`; suéltalo en cuanto termines. */
export const tomarExclusivo = () => tomar("pg_advisory_lock");
