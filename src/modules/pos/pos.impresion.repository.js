import { createHash, randomBytes } from "node:crypto";
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { payloadPrueba } from "./pos.logic.js";

const IMPRESORA_COLS = "id, empresa_id, nombre, conexion, ip, puerto, nombre_usb, ancho, area_id, es_ticket, activo";
const CONECTADO_SEG = 30;
const MAX_INTENTOS = 5;

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export default class PosImpresionRepository {
    // ---- Impresoras ----
    async listarImpresoras(empresa_id) {
        return (await pool.query(
            `SELECT i.${IMPRESORA_COLS.split(", ").join(", i.")}, a.nombre AS area
             FROM impresoras i LEFT JOIN areas_preparacion a ON a.id = i.area_id
             WHERE i.empresa_id = $1 ORDER BY i.es_ticket DESC, i.nombre`,
            [empresa_id],
        )).rows;
    }

    async #validarArea(empresa_id, area_id) {
        if (area_id == null) return;
        const r = await pool.query("SELECT 1 FROM areas_preparacion WHERE id = $1 AND empresa_id = $2", [area_id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.badRequest("El área no existe en la empresa");
    }

    async crearImpresora(empresa_id, d) {
        await this.#validarArea(empresa_id, d.area_id);
        try {
            const r = await pool.query(
                `INSERT INTO impresoras (empresa_id, nombre, conexion, ip, puerto, nombre_usb, ancho, area_id, es_ticket)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${IMPRESORA_COLS}`,
                [empresa_id, d.nombre, d.conexion, d.ip ?? null, d.puerto ?? 9100, d.nombre_usb ?? null, d.ancho ?? 80, d.area_id ?? null, d.es_ticket ?? false],
            );
            return r.rows[0];
        } catch (error) {
            if (error.code === "23505") throw ApiError.conflict("Ya existe una impresora con ese nombre");
            throw error;
        }
    }

    async actualizarImpresora(empresa_id, id, d) {
        const actual = (await pool.query(`SELECT ${IMPRESORA_COLS} FROM impresoras WHERE id = $1 AND empresa_id = $2`, [id, empresa_id])).rows[0];
        if (!actual) throw ApiError.notFound("Impresora no encontrada");
        const m = { ...actual, ...d };
        await this.#validarArea(empresa_id, m.area_id);
        try {
            const r = await pool.query(
                `UPDATE impresoras SET nombre=$3, conexion=$4, ip=$5, puerto=$6, nombre_usb=$7, ancho=$8, area_id=$9, es_ticket=$10, activo=$11
                 WHERE id=$1 AND empresa_id=$2 RETURNING ${IMPRESORA_COLS}`,
                [id, empresa_id, m.nombre, m.conexion, m.ip, m.puerto, m.nombre_usb, m.ancho, m.area_id, m.es_ticket, m.activo],
            );
            return r.rows[0];
        } catch (error) {
            if (error.code === "23505") throw ApiError.conflict("Ya existe una impresora con ese nombre");
            if (error.code === "23514") throw ApiError.badRequest("Revisa los datos: una impresora de red necesita IP, una USB su nombre, y debe atender un área o ser la de tickets");
            throw error;
        }
    }

    async imprimirPrueba(empresa_id, impresora_id) {
        const impresora = (await pool.query(`SELECT ${IMPRESORA_COLS} FROM impresoras WHERE id = $1 AND empresa_id = $2`, [impresora_id, empresa_id])).rows[0];
        if (!impresora) throw ApiError.notFound("Impresora no encontrada");
        const negocio = (await pool.query("SELECT nombre FROM empresas WHERE id = $1", [empresa_id])).rows[0]?.nombre ?? "";
        const r = await pool.query(
            `INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, payload) VALUES ($1,'PRUEBA',$2,$2,$3) RETURNING id, estado`,
            [empresa_id, impresora_id, JSON.stringify(payloadPrueba({ negocio, impresora }))],
        );
        return r.rows[0];
    }

    // ---- Agentes ----
    async listarAgentes(empresa_id) {
        return (await pool.query(
            `SELECT id, nombre, version, activo, ultimo_contacto, created_at,
                    (ultimo_contacto IS NOT NULL AND ultimo_contacto > now() - make_interval(secs => $2)) AS conectado
             FROM agentes_impresion WHERE empresa_id = $1 ORDER BY id`,
            [empresa_id, CONECTADO_SEG],
        )).rows;
    }

    // El token solo se muestra al crearlo/rotarlo: en la BD queda su hash.
    async crearAgente(empresa_id, nombre) {
        const token = `gh_agt_${randomBytes(24).toString("hex")}`;
        const r = await pool.query(
            "INSERT INTO agentes_impresion (empresa_id, nombre, token_hash) VALUES ($1,$2,$3) RETURNING id, nombre, activo, created_at",
            [empresa_id, nombre, hashToken(token)],
        );
        return { agente: r.rows[0], token };
    }

    async actualizarAgente(empresa_id, id, { nombre, activo }) {
        const r = await pool.query(
            "UPDATE agentes_impresion SET nombre = COALESCE($3, nombre), activo = COALESCE($4, activo) WHERE id = $1 AND empresa_id = $2 RETURNING id, nombre, activo",
            [id, empresa_id, nombre ?? null, activo ?? null],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Agente no encontrado");
        return r.rows[0];
    }

    async rotarToken(empresa_id, id) {
        const token = `gh_agt_${randomBytes(24).toString("hex")}`;
        const r = await pool.query("UPDATE agentes_impresion SET token_hash = $3 WHERE id = $1 AND empresa_id = $2 RETURNING id, nombre", [id, empresa_id, hashToken(token)]);
        if (r.rowCount === 0) throw ApiError.notFound("Agente no encontrado");
        return { agente: r.rows[0], token };
    }

    async autenticarAgente(token) {
        const r = await pool.query(
            "SELECT id, empresa_id FROM agentes_impresion WHERE token_hash = $1 AND activo", [hashToken(token)],
        );
        return r.rows[0] ?? null;
    }

    // ---- Cola ----
    async estado(empresa_id) {
        const [agentes, cola] = await Promise.all([
            pool.query(
                "SELECT COUNT(*)::int AS n FROM agentes_impresion WHERE empresa_id = $1 AND activo AND ultimo_contacto > now() - make_interval(secs => $2)",
                [empresa_id, CONECTADO_SEG],
            ),
            pool.query(
                `SELECT COUNT(*) FILTER (WHERE estado IN ('PENDIENTE','IMPRIMIENDO'))::int AS pendientes,
                        COUNT(*) FILTER (WHERE estado = 'ERROR' AND created_at > now() - interval '1 day')::int AS errores
                 FROM pos_impresiones WHERE empresa_id = $1`,
                [empresa_id],
            ),
        ]);
        return { agentes_conectados: agentes.rows[0].n, ...cola.rows[0] };
    }

    async cola(empresa_id, { estado = null, limit = 50 } = {}) {
        return (await pool.query(
            `SELECT p.id, p.tipo, p.referencia_id, p.estado, p.intentos, p.error, p.created_at, p.impreso_at,
                    p.payload->>'mesa' AS mesa, p.payload->>'area' AS area, p.payload->>'folio' AS folio, i.nombre AS impresora
             FROM pos_impresiones p LEFT JOIN impresoras i ON i.id = p.impresora_id
             WHERE p.empresa_id = $1 AND ($2::text IS NULL OR p.estado = $2) ORDER BY p.id DESC LIMIT $3`,
            [empresa_id, estado, limit],
        )).rows;
    }

    // Vuelve a encolar un trabajo (p. ej. tras configurar la impresora que faltaba).
    async reimprimir(empresa_id, id) {
        const job = (await pool.query("SELECT id, tipo, payload, referencia_id FROM pos_impresiones WHERE id = $1 AND empresa_id = $2", [id, empresa_id])).rows[0];
        if (!job) throw ApiError.notFound("Trabajo de impresión no encontrado");
        let impresora;
        if (job.tipo === "COMANDA") {
            impresora = (await pool.query("SELECT id FROM impresoras WHERE empresa_id = $1 AND area_id = $2 AND activo ORDER BY id LIMIT 1", [empresa_id, job.payload.area_id])).rows[0];
            if (!impresora) throw ApiError.badRequest(`No hay una impresora activa para el área ${job.payload.area ?? ""}. Configúrala en Impresoras.`);
        } else if (job.tipo === "PRUEBA") {
            impresora = (await pool.query("SELECT id FROM impresoras WHERE id = $1 AND empresa_id = $2 AND activo", [job.referencia_id, empresa_id])).rows[0];
            if (!impresora) throw ApiError.badRequest("La impresora de esta prueba ya no está activa");
        } else {
            impresora = (await pool.query("SELECT id FROM impresoras WHERE empresa_id = $1 AND es_ticket AND activo ORDER BY id LIMIT 1", [empresa_id])).rows[0];
            if (!impresora) throw ApiError.badRequest("No hay una impresora de tickets activa. Configúrala en Impresoras.");
        }
        const r = await pool.query(
            `UPDATE pos_impresiones SET estado = 'PENDIENTE', impresora_id = $3, intentos = 0, error = NULL, bloqueado_hasta = NULL, impreso_at = NULL,
                    reimpresiones = reimpresiones + CASE WHEN estado = 'ERROR' AND impreso_at IS NULL THEN 0 ELSE 1 END
             WHERE id = $1 AND empresa_id = $2 RETURNING id, estado`,
            [id, empresa_id, impresora.id],
        );
        return r.rows[0];
    }

    // ---- Lado del agente ----
    async registrarContacto(agente_id, version) {
        await pool.query("UPDATE agentes_impresion SET ultimo_contacto = now(), version = COALESCE($2, version) WHERE id = $1", [agente_id, version ?? null]);
    }

    // Toma trabajos pendientes de forma atómica. Uno tomado y no confirmado en 30 s se reintenta;
    // tras MAX_INTENTOS queda en ERROR para que el POS lo avise.
    async reclamarPendientes(empresa_id, limite = 20) {
        await pool.query(
            `UPDATE pos_impresiones SET estado = 'ERROR', error = COALESCE(error, 'El agente no confirmó la impresión')
             WHERE empresa_id = $1 AND estado = 'IMPRIMIENDO' AND bloqueado_hasta < now() AND intentos >= $2`,
            [empresa_id, MAX_INTENTOS - 1],
        );
        const r = await pool.query(
            `WITH cand AS (
                SELECT id FROM pos_impresiones
                WHERE empresa_id = $1 AND impresora_id IS NOT NULL
                  AND ((estado = 'PENDIENTE' AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now()))
                    OR (estado = 'IMPRIMIENDO' AND bloqueado_hasta < now()))
                ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
             UPDATE pos_impresiones p
             SET estado = 'IMPRIMIENDO', bloqueado_hasta = now() + interval '30 seconds',
                 intentos = p.intentos + CASE WHEN p.estado = 'IMPRIMIENDO' THEN 1 ELSE 0 END
             FROM cand WHERE p.id = cand.id
             RETURNING p.id, p.tipo, p.payload, p.intentos, p.impresora_id, p.reimpresiones`,
            [empresa_id, limite],
        );
        if (r.rowCount === 0) return [];
        const impresoras = (await pool.query(
            "SELECT id, nombre, conexion, ip, puerto, nombre_usb, ancho FROM impresoras WHERE id = ANY($1::int[])", [[...new Set(r.rows.map((j) => j.impresora_id))]],
        )).rows;
        const porId = new Map(impresoras.map((i) => [i.id, i]));
        return r.rows
            .sort((a, b) => a.id - b.id)
            .map((j) => ({ id: j.id, reimpresiones: j.reimpresiones, tipo: j.tipo, payload: j.payload, impresora: porId.get(j.impresora_id) }));
    }

    async resultado(empresa_id, id, { ok, error }) {
        const job = (await pool.query(
            "SELECT id, intentos FROM pos_impresiones WHERE id = $1 AND empresa_id = $2 AND estado = 'IMPRIMIENDO' FOR UPDATE", [id, empresa_id],
        )).rows[0];
        if (!job) throw ApiError.notFound("El trabajo ya no está en impresión");
        if (ok) {
            await pool.query("UPDATE pos_impresiones SET estado = 'IMPRESO', impreso_at = now(), error = NULL, bloqueado_hasta = NULL WHERE id = $1", [id]);
            return { id, estado: "IMPRESO" };
        }
        const intentos = job.intentos + 1;
        const agotado = intentos >= MAX_INTENTOS;
        await pool.query(
            `UPDATE pos_impresiones SET estado = $2::varchar, intentos = $3, error = $4,
                    bloqueado_hasta = CASE WHEN $2::varchar = 'PENDIENTE' THEN now() + make_interval(secs => $5) END WHERE id = $1`,
            [id, agotado ? "ERROR" : "PENDIENTE", intentos, String(error ?? "Error de impresión").slice(0, 300), intentos * 10],
        );
        return { id, estado: agotado ? "ERROR" : "PENDIENTE" };
    }
}
