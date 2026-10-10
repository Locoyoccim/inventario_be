import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { appUrl, enviarCorreo } from "../../utils/mailer.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";

const VIGENCIA_DIAS = 7;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const escapar = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Enlace de un solo uso para que el usuario defina su contraseña. Un enlace nuevo anula los anteriores sin usar.
export async function crearInvitacion(usuario_id, db = pool) {
    const token = randomBytes(32).toString("base64url");
    await db.query(
        "DELETE FROM usuario_tokens WHERE usuario_id = $1 AND tipo = 'INVITACION' AND usado_at IS NULL",
        [usuario_id],
    );
    const r = await db.query(
        `INSERT INTO usuario_tokens (usuario_id, tipo, token_hash, expira_at)
         VALUES ($1, 'INVITACION', $2, now() + make_interval(days => $3)) RETURNING expira_at`,
        [usuario_id, hashToken(token), VIGENCIA_DIAS],
    );
    return { token, url: `${appUrl()}/invitacion/${token}`, expira_at: r.rows[0].expira_at };
}

// Crea el enlace y lo manda por correo. Si el correo no sale, devuelve la URL para entregarla a mano.
export async function invitarUsuario({ usuario_id, nombre, email, empresa }) {
    const inv = await crearInvitacion(usuario_id);
    const dias = VIGENCIA_DIAS;
    const asunto = "Activa tu cuenta de NexoMesa";
    const texto = `Hola ${nombre},\n\nTu cuenta de NexoMesa para ${empresa} está lista. Define tu contraseña aquí (el enlace funciona una sola vez y vence en ${dias} días):\n\n${inv.url}\n\nSi no esperabas este correo, ignóralo.`;
    const html =
        `<p>Hola ${escapar(nombre)},</p><p>Tu cuenta de <strong>NexoMesa</strong> para <strong>${escapar(empresa)}</strong> está lista.</p>` +
        `<p><a href="${inv.url}" style="display:inline-block;padding:12px 20px;background:#2a2622;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">Definir mi contraseña</a></p>` +
        `<p style="color:#666;font-size:13px">El enlace funciona una sola vez y vence en ${dias} días. Si no esperabas este correo, ignóralo.</p>`;
    const envio = await enviarCorreo({ to: email, subject: asunto, text: texto, html });
    return {
        enviada: envio.enviado,
        expira_at: inv.expira_at,
        ...(envio.enviado ? {} : { motivo: envio.motivo, url: inv.url }),
    };
}

const INVALIDA = "La invitación no es válida o ya venció. Pide que te la envíen de nuevo.";

// Datos para la pantalla de activación (no revela nada si el enlace no sirve).
export async function consultarInvitacion(token) {
    const r = await pool.query(
        `SELECT u.nombre, u.email, e.nombre AS empresa
         FROM usuario_tokens t JOIN usuarios u ON u.id = t.usuario_id LEFT JOIN empresas e ON e.id = u.empresa_id
         WHERE t.token_hash = $1 AND t.tipo = 'INVITACION' AND t.usado_at IS NULL AND t.expira_at > now() AND u.activo`,
        [hashToken(token)],
    );
    if (!r.rows[0]) throw ApiError.notFound(INVALIDA).conEvento("invitacion_invalida");
    return r.rows[0];
}

// Define la contraseña y consume el enlace en una sola operación atómica (no se puede usar dos veces).
export async function aceptarInvitacion(token, password) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const t = await client.query(
            `UPDATE usuario_tokens SET usado_at = now()
             WHERE token_hash = $1 AND tipo = 'INVITACION' AND usado_at IS NULL AND expira_at > now() RETURNING usuario_id`,
            [hashToken(token)],
        );
        if (!t.rows[0]) throw ApiError.notFound(INVALIDA).conEvento("invitacion_invalida");
        const usuario_id = t.rows[0].usuario_id;
        const password_hash = await bcrypt.hash(password, 12);
        const u = await client.query(
            `UPDATE usuarios SET password_hash = $2, must_change_password = false, token_version = token_version + 1
             WHERE id = $1 AND activo RETURNING id, email`,
            [usuario_id, password_hash],
        );
        if (!u.rows[0]) throw ApiError.notFound(INVALIDA).conEvento("invitacion_invalida");
        await client.query("COMMIT");
        invalidarUsuarioActivo(usuario_id);
        return { email: u.rows[0].email };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
