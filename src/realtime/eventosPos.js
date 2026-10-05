// Avisos en tiempo real del POS: Postgres LISTEN/NOTIFY -> SSE (server-sent events).
//
//  · Los repositorios llaman a `notificar(db, evento)`. Dentro de una transacción, `pg_notify` se entrega al CONFIRMAR (si hay
//    rollback no sale nada) y funciona entre varias instancias del servidor, porque pasa por la base de datos.
//  · Cada instancia mantiene UNA conexión propia (fuera del pool) con `LISTEN pos_eventos` y reparte lo que llega a los
//    clientes SSE conectados de esa empresa.
//  · Los eventos son AVISOS con ids (nunca datos): quien los recibe vuelve a pedir el estado. Por eso perder uno no es grave y
//    al reconectar (del servidor o del cliente) se manda `resync` para que todos refresquen.
import pg from "pg";
import { opcionesConexion } from "../config/db.js";
import { logger } from "../utils/logger.js";

const CANAL = "pos_eventos";
const suscriptores = new Map(); // empresa_id -> Set<(evento) => void>
let cliente = null;
let reintento = null;
let intentos = 0;
let cerrado = false;
let huboCaida = false;
let enCurso = null; // promesa de la conexión que se está abriendo

/** Publica un aviso. Con `db` = un cliente en transacción, sale al hacer COMMIT. Solo ids: el payload tiene tope de 8 000 bytes. */
export function notificar(db, evento) {
    // Los ids pueden llegar como texto (parámetros de la ruta): se normalizan para que el filtro por empresa coincida.
    const normal = { ...evento, empresa_id: Number(evento.empresa_id) };
    for (const clave of ["cuenta_id", "comanda_id", "mesero_id", "impresion_id"]) if (normal[clave] !== undefined && normal[clave] !== null) normal[clave] = Number(normal[clave]);
    return db.query("SELECT pg_notify($1, $2)", [CANAL, JSON.stringify(normal)]);
}

function repartir(evento) {
    const quienes = suscriptores.get(evento.empresa_id);
    if (!quienes) return;
    for (const enviar of quienes) {
        try {
            enviar(evento);
        } catch (error) {
            logger.warn("eventos_pos_envio", { error: error.message });
        }
    }
}

function repartirATodos(evento) {
    for (const quienes of suscriptores.values()) for (const enviar of quienes) enviar(evento);
}

function programarReintento() {
    if (cerrado || reintento) return;
    const espera = Math.min(30_000, 1000 * 2 ** Math.min(intentos, 5));
    intentos += 1;
    reintento = setTimeout(() => {
        reintento = null;
        void escuchar();
    }, espera);
    reintento.unref?.();
}

function escuchar() {
    if (cerrado) return Promise.resolve();
    if (cliente) return enCurso ?? Promise.resolve();
    enCurso = abrir().finally(() => {
        enCurso = null;
    });
    return enCurso;
}

async function abrir() {
    const nuevo = new pg.Client({ ...opcionesConexion, keepAlive: true });
    cliente = nuevo;
    const caer = (error) => {
        if (cliente !== nuevo) return;
        cliente = null;
        huboCaida = true;
        logger.warn("eventos_pos_caida", { error: error?.message });
        nuevo.removeAllListeners();
        nuevo.on("error", () => {});
        nuevo.end().catch(() => {});
        programarReintento();
    };
    nuevo.on("error", caer);
    nuevo.on("end", () => caer(new Error("conexión cerrada")));
    nuevo.on("notification", (mensaje) => {
        try {
            const evento = JSON.parse(mensaje.payload);
            if (evento && Number.isInteger(evento.empresa_id)) repartir(evento);
        } catch {
            // un aviso mal formado no debe tumbar la escucha
        }
    });
    try {
        await nuevo.connect();
        await nuevo.query(`LISTEN ${CANAL}`);
        intentos = 0;
        // Tras una caída pudo perderse algo: todos vuelven a pedir su estado.
        if (huboCaida) {
            huboCaida = false;
            repartirATodos({ tipo: "resync" });
        }
    } catch (error) {
        caer(error);
    }
}

/** Espera a que la escucha de la base esté activa (o falle): para no anunciar «conectado» antes de poder recibir avisos. */
export const escuchaLista = () => escuchar().catch(() => {});

/** Suscribe a los avisos de una empresa. Devuelve la función para cancelar. Abre la escucha la primera vez. */
export function suscribir(empresa_id, enviar) {
    if (!suscriptores.has(empresa_id)) suscriptores.set(empresa_id, new Set());
    suscriptores.get(empresa_id).add(enviar);
    void escuchar();
    return () => {
        const quienes = suscriptores.get(empresa_id);
        quienes?.delete(enviar);
        if (quienes?.size === 0) suscriptores.delete(empresa_id);
    };
}

/** Cierra la escucha y a todos los suscriptores (apagado del servidor y pruebas). */
export async function cerrarEventos() {
    cerrado = true;
    if (reintento) clearTimeout(reintento);
    reintento = null;
    repartirATodos({ tipo: "cierre" });
    suscriptores.clear();
    const actual = cliente;
    cliente = null;
    if (actual) {
        actual.removeAllListeners();
        actual.on("error", () => {});
        await actual.end().catch(() => {});
    }
}

/** Solo para pruebas: permite volver a abrir la escucha después de cerrarla. */
export function reiniciarEventos() {
    cerrado = false;
    intentos = 0;
    huboCaida = false;
}
