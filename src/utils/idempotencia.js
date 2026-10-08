// Idempotencia de las operaciones del POS que no deben repetirse (abrir cuenta, agregar, enviar, cobrar).
//
// El cliente manda una llave única por acción en el header `Idempotency-Key`. Si la operación ya se hizo con esa llave,
// se devuelve la misma respuesta (header `Idempotent-Replay: true`) y no se vuelve a ejecutar. Sin el header, nada cambia.
//
//  · La llave se reserva dentro de la transacción del efecto (reclamarIdempotencia, llamada desde el repositorio): dos
//    peticiones iguales a la vez se serializan por el índice único y solo una produce el efecto.
//  · La respuesta se guarda al terminar (solo si fue 2xx). Los errores no se guardan: tras un 4xx/5xx la misma llave
//    puede volver a intentarse porque la transacción hizo rollback y la reserva desapareció.
//  · La misma llave con otro cuerpo es un error del cliente (422).
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import pool from "../config/db.js";
import ApiError from "./ApiError.js";
import { logger } from "./logger.js";

const almacen = new AsyncLocalStorage();
const CLAVE_VALIDA = /^[A-Za-z0-9_-]{8,80}$/;
const ESPERA_MS = 150;
const ESPERAS_MAX = 20; // ~3 s esperando la respuesta de la petición original
const RETENCION = "48 hours";

/** La llave ya estaba reservada: otra petición igual hizo (o está terminando de hacer) el trabajo. */
export class OperacionRepetida extends Error {
    constructor() {
        super("Operación repetida");
        this.name = "OperacionRepetida";
    }
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const hashDe = (req) => crypto.createHash("sha256").update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`).digest("hex");

/**
 * Se llama dentro de la transacción del efecto, justo después de BEGIN. Sin contexto de idempotencia no hace nada.
 * Solo reserva una vez por petición (una petición con varias transacciones reserva en la primera).
 */
export async function reclamarIdempotencia(client) {
    const ctx = almacen.getStore();
    if (!ctx || ctx.reclamado) return;
    const r = await client.query(
        `INSERT INTO pos_idempotencia (empresa_id, usuario_id, clave, endpoint, req_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [ctx.empresa_id, ctx.usuario_id, ctx.clave, ctx.endpoint, ctx.hash],
    );
    if (r.rowCount === 0) throw new OperacionRepetida();
    ctx.reclamado = true;
}

async function buscar(ctx) {
    const r = await pool.query(
        "SELECT req_hash, status, respuesta FROM pos_idempotencia WHERE empresa_id = $1 AND usuario_id = $2 AND clave = $3 AND endpoint = $4",
        [ctx.empresa_id, ctx.usuario_id, ctx.clave, ctx.endpoint],
    );
    return r.rows[0] ?? null;
}

// Responde lo que ya se hizo con esta llave. Devuelve true si respondió.
async function responderGuardada(ctx, res) {
    for (let i = 0; i < ESPERAS_MAX; i++) {
        const fila = await buscar(ctx);
        if (!fila) return false;
        if (fila.req_hash.trim() !== ctx.hash) throw new ApiError(422, "La llave de idempotencia ya se usó con otra solicitud distinta");
        if (fila.status > 0) {
            res.set("Idempotent-Replay", "true");
            res.status(fila.status).json(fila.respuesta);
            return true;
        }
        await pausa(ESPERA_MS);
    }
    throw ApiError.conflict("La operación ya se procesó, pero su respuesta no está disponible. Actualiza la pantalla para verla.");
}

function purgarViejas() {
    // Oportunista y sin esperar: no vale la pena un proceso aparte para unas cuantas filas.
    if (Math.random() > 0.02) return;
    pool.query(`DELETE FROM pos_idempotencia WHERE created_at < now() - interval '${RETENCION}'`).catch((error) => logger.warn("idempotencia_purga", { error: error.message }));
}

// Antes del handler: lee la llave, atiende repeticiones y deja el contexto para el repositorio.
function preparar(req, res, next) {
    const clave = req.get("idempotency-key");
    if (!clave) return next();
    if (!CLAVE_VALIDA.test(clave)) return next(ApiError.badRequest("Idempotency-Key inválida (8 a 80 caracteres: letras, números, guion y guion bajo)"));

    const ctx = {
        empresa_id: Number(req.params.empresa_id),
        usuario_id: req.user.id,
        clave,
        endpoint: `${req.method} ${req.baseUrl}${req.route.path}`.slice(0, 160),
        hash: hashDe(req),
        reclamado: false,
    };
    req.idempotencia = ctx;

    responderGuardada(ctx, res)
        .then((respondio) => {
            if (respondio) return;
            purgarViejas();
            // Al terminar con éxito se guarda la respuesta junto a la reserva que hizo el repositorio.
            const jsonOriginal = res.json.bind(res);
            res.json = (cuerpo) => {
                if (!ctx.reclamado || res.statusCode >= 300) return jsonOriginal(cuerpo);
                pool
                    .query("UPDATE pos_idempotencia SET status = $5, respuesta = $6 WHERE empresa_id = $1 AND usuario_id = $2 AND clave = $3 AND endpoint = $4", [
                        ctx.empresa_id, ctx.usuario_id, ctx.clave, ctx.endpoint, res.statusCode, JSON.stringify(cuerpo),
                    ])
                    .catch((error) => logger.warn("idempotencia_guardar", { error: error.message }))
                    .finally(() => jsonOriginal(cuerpo));
                return res;
            };
            almacen.run(ctx, next);
        })
        .catch(next);
}

// Después del handler: si la reserva se perdió en una carrera, se responde con lo que hizo la petición original.
function repetida(err, req, res, next) {
    if (!(err instanceof OperacionRepetida) || !req.idempotencia) return next(err);
    responderGuardada(req.idempotencia, res)
        .then((respondio) => {
            if (!respondio) next(ApiError.conflict("La operación se está procesando: vuelve a intentar en un momento."));
        })
        .catch(next);
}

/** Envuelve un handler de ruta: `router.post(ruta, ...permisos, ...conIdempotencia(handler))`. */
export const conIdempotencia = (handler) => [preparar, handler, repetida];
