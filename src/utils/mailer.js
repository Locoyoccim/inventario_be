import nodemailer from "nodemailer";
import logger from "./logger.js";

// Envío de correo por SMTP (cualquier proveedor: Resend, SendGrid, Postmark, Gmail, el del hosting...).
//   SMTP_URL=smtps://usuario:clave@smtp.proveedor.com        (o bien)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE=true|false
//   MAIL_FROM="Gastronomy Hub <no-reply@tudominio.com>"
// Sin configuración el sistema sigue funcionando: `enviarCorreo` devuelve { enviado: false } y quien lo llama
// muestra el enlace al administrador para que lo entregue a mano.

// En pruebas no sale nada a la red: los mensajes quedan aquí para verificarlos.
export const correosDePrueba = [];

let transporte;
function obtenerTransporte() {
    if (transporte !== undefined) return transporte;
    if (process.env.NODE_ENV === "test") {
        transporte = nodemailer.createTransport({ jsonTransport: true, skipEncoding: true });
    } else if (process.env.SMTP_URL) {
        transporte = nodemailer.createTransport(process.env.SMTP_URL);
    } else if (process.env.SMTP_HOST) {
        const puerto = Number(process.env.SMTP_PORT) || 587;
        transporte = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: puerto,
            secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : puerto === 465,
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
        });
    } else {
        transporte = null;
    }
    return transporte;
}

export const correoConfigurado = () => obtenerTransporte() !== null;

// Dirección base del front, para armar los enlaces de los correos.
export function appUrl() {
    const base =
        process.env.APP_URL ||
        process.env.CORS_ORIGINS?.split(",")[0]?.trim() ||
        "http://localhost:5173";
    return base.replace(/\/+$/, "");
}

/** Envía un correo. Nunca lanza: devuelve { enviado, motivo? } para que un fallo de correo no rompa el alta. */
export async function enviarCorreo({ to, subject, text, html }) {
    const t = obtenerTransporte();
    if (!t) return { enviado: false, motivo: "El envío de correo no está configurado (SMTP)." };
    try {
        const from = process.env.MAIL_FROM || "Gastronomy Hub <no-reply@localhost>";
        const info = await t.sendMail({ from, to, subject, text, html });
        if (process.env.NODE_ENV === "test") correosDePrueba.push(info.message);
        return { enviado: true };
    } catch (error) {
        logger.error("No se pudo enviar el correo", { to, error: error.message });
        return {
            enviado: false,
            motivo: "No se pudo enviar el correo. Revisa la configuración SMTP.",
        };
    }
}
