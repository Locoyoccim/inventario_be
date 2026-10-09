import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import {
    generarCodigo,
    generarTokenDispositivo,
    hashCodigo,
    hashToken,
    LIMITES,
    VIGENCIA_CODIGO_MIN,
} from "../auth/pin.logic.js";

// Estado legible de un equipo a partir de sus columnas.
const ESTADO_SQL = `CASE
    WHEN NOT d.activo THEN 'REVOCADO'
    WHEN d.token_hash IS NOT NULL AND d.codigo_hash IS NULL THEN 'ACTIVO'
    WHEN d.token_hash IS NOT NULL THEN 'ACTIVO_CON_CODIGO'
    WHEN d.codigo_expira_at > now() THEN 'PENDIENTE'
    ELSE 'CODIGO_VENCIDO'
END`;

const COLUMNAS = `d.id, d.nombre, d.activo, d.activado_at, d.ultimo_uso, d.revocado_at, d.created_at, d.codigo_expira_at, ${ESTADO_SQL} AS estado`;

/** Equipos registrados (el celular o la tablet desde la que se entra con PIN) y sus códigos de registro. */
export default class DispositivoRepository {
    async listar(empresa_id) {
        const r = await pool.query(
            `SELECT ${COLUMNAS} FROM dispositivos d WHERE d.empresa_id = $1 ORDER BY d.id`,
            [empresa_id],
        );
        return r.rows;
    }

    // El código solo se muestra al crearlo: en la base queda su hash.
    async crear(empresa_id, nombre, creado_por) {
        const codigo = generarCodigo();
        const r = await pool.query(
            `INSERT INTO dispositivos (empresa_id, nombre, codigo_hash, codigo_expira_at, creado_por)
             VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5) RETURNING id`,
            [empresa_id, nombre, hashCodigo(codigo), VIGENCIA_CODIGO_MIN, creado_por ?? null],
        );
        return {
            dispositivo: await this.#uno(empresa_id, r.rows[0].id),
            codigo,
            vigencia_min: VIGENCIA_CODIGO_MIN,
        };
    }

    // Código nuevo para volver a registrar un equipo (se cambió de teléfono, se borró la cookie). El token vigente sigue
    // sirviendo hasta que se canjee el código: ahí el anterior deja de valer.
    async nuevoCodigo(empresa_id, id) {
        const codigo = generarCodigo();
        const r = await pool.query(
            `UPDATE dispositivos SET codigo_hash = $3, codigo_expira_at = now() + make_interval(mins => $4)
             WHERE id = $1 AND empresa_id = $2 AND activo RETURNING id`,
            [id, empresa_id, hashCodigo(codigo), VIGENCIA_CODIGO_MIN],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Equipo no encontrado o revocado");
        return {
            dispositivo: await this.#uno(empresa_id, id),
            codigo,
            vigencia_min: VIGENCIA_CODIGO_MIN,
        };
    }

    // Revocar no borra el equipo: queda en la lista como revocado y su token deja de valer.
    async revocar(empresa_id, id) {
        const r = await pool.query(
            `UPDATE dispositivos SET activo = false, revocado_at = now(), token_hash = NULL, codigo_hash = NULL, codigo_expira_at = NULL
             WHERE id = $1 AND empresa_id = $2 RETURNING id`,
            [id, empresa_id],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Equipo no encontrado");
        return this.#uno(empresa_id, id);
    }

    async renombrar(empresa_id, id, nombre) {
        const r = await pool.query(
            "UPDATE dispositivos SET nombre = $3 WHERE id = $1 AND empresa_id = $2 RETURNING id",
            [id, empresa_id, nombre],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Equipo no encontrado");
        return this.#uno(empresa_id, id);
    }

    // Canje atómico: un solo UPDATE consume el código (un solo uso) y guarda el hash del token nuevo.
    async canjearCodigo(codigo) {
        const token = generarTokenDispositivo();
        const r = await pool.query(
            `UPDATE dispositivos d SET token_hash = $2, codigo_hash = NULL, codigo_expira_at = NULL, activado_at = now(), ultimo_uso = now()
             FROM empresas e
             WHERE d.codigo_hash = $1 AND d.codigo_expira_at > now() AND d.activo AND e.id = d.empresa_id AND e.activo
             RETURNING d.id, d.empresa_id, d.nombre`,
            [hashCodigo(codigo), hashToken(token)],
        );
        if (r.rowCount === 0)
            throw ApiError.badRequest(
                "El código no es válido o ya venció. Pide uno nuevo a un administrador.",
            );
        return { dispositivo: r.rows[0], token };
    }

    async porToken(token) {
        if (!token) return null;
        const r = await pool.query(
            `SELECT d.id, d.empresa_id, d.nombre FROM dispositivos d JOIN empresas e ON e.id = d.empresa_id
             WHERE d.token_hash = $1 AND d.activo AND e.activo`,
            [hashToken(token)],
        );
        return r.rows[0] ?? null;
    }

    async estaActivo(id) {
        const r = await pool.query(
            "SELECT 1 FROM dispositivos d JOIN empresas e ON e.id = d.empresa_id WHERE d.id = $1 AND d.activo AND e.activo",
            [id],
        );
        return r.rowCount > 0;
    }

    // ---- Personal con PIN y fallos ----
    async personal(empresa_id) {
        const r = await pool.query(
            `SELECT id, nombre, puesto FROM usuarios
             WHERE empresa_id = $1 AND activo AND pin_hash IS NOT NULL AND NOT is_admin AND NOT is_owner AND NOT is_platform_admin
             ORDER BY nombre`,
            [empresa_id],
        );
        return r.rows;
    }

    async usuarioParaPin(empresa_id, usuario_id) {
        const r = await pool.query(
            `SELECT u.id, u.nombre, u.email, u.empresa_id, u.is_admin, u.is_owner, u.is_platform_admin, u.must_change_password,
                    u.role_id, u.activo, u.token_version, u.pin_hash, u.pin_bloqueado_at, r.permisos
             FROM usuarios u LEFT JOIN roles r ON r.id = u.role_id
             WHERE u.id = $1 AND u.empresa_id = $2`,
            [usuario_id, empresa_id],
        );
        return r.rows[0] ?? null;
    }

    // Fallos recientes (ventana de 15 min) por usuario+equipo, equipo e IP, con la hora del servidor de base de datos.
    async fallosRecientes(usuario_id, dispositivo_id, ip) {
        const r = await pool.query(
            `SELECT EXTRACT(EPOCH FROM now()) * 1000 AS ahora_ms,
                    COUNT(*) FILTER (WHERE usuario_id = $1 AND dispositivo_id = $2)::int AS ud_n,
                    EXTRACT(EPOCH FROM MAX(created_at) FILTER (WHERE usuario_id = $1 AND dispositivo_id = $2)) * 1000 AS ud_ultimo,
                    COUNT(*) FILTER (WHERE dispositivo_id = $2)::int AS d_n,
                    EXTRACT(EPOCH FROM MAX(created_at) FILTER (WHERE dispositivo_id = $2)) * 1000 AS d_ultimo,
                    COUNT(*) FILTER (WHERE ip IS NOT DISTINCT FROM $3::text)::int AS ip_n,
                    EXTRACT(EPOCH FROM MAX(created_at) FILTER (WHERE ip IS NOT DISTINCT FROM $3::text)) * 1000 AS ip_ultimo
             FROM pin_fallos
             WHERE created_at > now() - make_interval(mins => $4)
               AND (dispositivo_id = $2 OR ip IS NOT DISTINCT FROM $3::text)`,
            [usuario_id, dispositivo_id, ip ?? null, LIMITES.ventanaMin],
        );
        const f = r.rows[0];
        const g = (n, ultimo) => ({
            n: Number(n),
            ultimoMs: ultimo == null ? null : Number(ultimo),
        });
        return {
            ahoraMs: Number(f.ahora_ms),
            usuarioDispositivo: g(f.ud_n, f.ud_ultimo),
            dispositivo: g(f.d_n, f.d_ultimo),
            ip: g(f.ip_n, f.ip_ultimo),
        };
    }

    // Registra el fallo y, si el usuario acumula demasiados en la ventana larga, lo bloquea (solo un Admin lo quita).
    async registrarFallo(empresa_id, usuario_id, dispositivo_id, ip) {
        await pool.query(
            "INSERT INTO pin_fallos (empresa_id, usuario_id, dispositivo_id, ip) VALUES ($1,$2,$3,$4)",
            [empresa_id, usuario_id, dispositivo_id, ip ?? null],
        );
        const r = await pool.query(
            "SELECT COUNT(*)::int AS n FROM pin_fallos WHERE usuario_id = $1 AND created_at > now() - make_interval(mins => $2)",
            [usuario_id, LIMITES.duro.ventanaMin],
        );
        if (r.rows[0].n >= LIMITES.duro.max) {
            await pool.query(
                "UPDATE usuarios SET pin_bloqueado_at = COALESCE(pin_bloqueado_at, now()) WHERE id = $1",
                [usuario_id],
            );
        }
        // Limpieza de contadores vencidos (no es historial de negocio): de vez en cuando basta.
        if (Math.random() < 0.02)
            await pool.query("DELETE FROM pin_fallos WHERE created_at < now() - interval '1 day'");
    }

    async limpiarFallos(usuario_id, dispositivo_id) {
        await pool.query("DELETE FROM pin_fallos WHERE usuario_id = $1 AND dispositivo_id = $2", [
            usuario_id,
            dispositivo_id,
        ]);
    }

    async marcarUso(dispositivo_id) {
        await pool.query("UPDATE dispositivos SET ultimo_uso = now() WHERE id = $1", [
            dispositivo_id,
        ]);
    }

    // ---- Administración del PIN de un usuario ----
    async guardarPin(empresa_id, usuario_id, pin_hash) {
        const r = await pool.query(
            `UPDATE usuarios SET pin_hash = $3, pin_actualizado_at = now(), pin_bloqueado_at = NULL
             WHERE id = $1 AND empresa_id = $2 AND NOT is_admin AND NOT is_owner AND NOT is_platform_admin RETURNING id`,
            [usuario_id, empresa_id, pin_hash],
        );
        if (r.rowCount === 0)
            throw ApiError.badRequest(
                "Ese usuario no puede usar PIN (los administradores entran con correo y contraseña)",
            );
        await pool.query("DELETE FROM pin_fallos WHERE usuario_id = $1", [usuario_id]);
    }

    async quitarPin(empresa_id, usuario_id) {
        const r = await pool.query(
            "UPDATE usuarios SET pin_hash = NULL, pin_actualizado_at = now(), pin_bloqueado_at = NULL WHERE id = $1 AND empresa_id = $2 RETURNING id",
            [usuario_id, empresa_id],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Usuario no encontrado");
        await pool.query("DELETE FROM pin_fallos WHERE usuario_id = $1", [usuario_id]);
    }

    async desbloquear(empresa_id, usuario_id) {
        const r = await pool.query(
            "UPDATE usuarios SET pin_bloqueado_at = NULL WHERE id = $1 AND empresa_id = $2 RETURNING id",
            [usuario_id, empresa_id],
        );
        if (r.rowCount === 0) throw ApiError.notFound("Usuario no encontrado");
        await pool.query("DELETE FROM pin_fallos WHERE usuario_id = $1", [usuario_id]);
    }

    async #uno(empresa_id, id) {
        const r = await pool.query(
            `SELECT ${COLUMNAS} FROM dispositivos d WHERE d.id = $1 AND d.empresa_id = $2`,
            [id, empresa_id],
        );
        return r.rows[0];
    }
}
