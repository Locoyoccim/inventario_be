import { logger } from "./logger.js";
import { enmascararCorreo } from "./redactar.js";

// Eventos de seguridad: lo que un monitor debe poder buscar y contar («¿cuántos login_fallido desde esta IP en 10 minutos?»).
// Los NOMBRES son un contrato estable con las alertas (docs/OBSERVABILIDAD.md): se pueden añadir, no renombrar.
// Cada evento sale como una línea `security` con requestId, ip, usuario y empresa de la petición; nunca con contraseñas, PIN ni tokens.
export const EVENTOS = Object.freeze({
    // Acceso con correo y contraseña
    login_fallido: "Correo o contraseña incorrectos",
    login_bloqueado: "Contraseña correcta pero la cuenta o la empresa están desactivadas",
    password_actual_incorrecta: "Cambio de contraseña con la actual equivocada",
    setup_token_invalido: "Intento de setup con un SETUP_TOKEN equivocado",
    invitacion_invalida: "Enlace de invitación inválido, usado o vencido",
    // Sesión
    token_invalido: "Token alterado, falsificado o vencido",
    csrf_faltante: "Escritura con cookie sin la cabecera anti-CSRF",
    sesion_revocada: "Token de una sesión ya cerrada (cierre global o forzado)",
    usuario_desactivado: "Sesión de un usuario desactivado",
    empresa_desactivada: "Sesión de una empresa desactivada",
    sesion_empresa_invalida: "El token apunta a una empresa que ya no le corresponde a la persona",
    sesion_pin_invalida:
        "Sesión de PIN que ya no vale (equipo revocado, persona ascendida o empresa compartida)",
    cambio_empresa_denegado: "Intento de cambiar a una empresa sin acceso",
    // Aislamiento entre empresas y permisos
    empresa_ajena: "Petición a los datos de otra empresa distinta a la del token",
    recurso_ajeno: "Petición a un recurso que pertenece a otra empresa",
    permiso_denegado: "Acción que el rol de la persona no permite",
    // PIN y equipos
    pin_fallido: "PIN incorrecto",
    pin_en_espera: "PIN rechazado por enfriamiento tras varios fallos",
    pin_bloqueado: "PIN bloqueado: solo un administrador lo desbloquea",
    equipo_no_registrado: "Ingreso con PIN desde un equipo no registrado o revocado",
    equipo_codigo_invalido: "Código de registro de equipo inválido o vencido",
    // Agente de impresión y supervisores
    agente_token_invalido: "Token de agente ausente, inválido o desactivado",
    agente_codigo_invalido: "Código de emparejamiento de agente inválido o vencido",
    supervisor_credenciales_invalidas:
        "Credenciales de supervisor equivocadas al autorizar una acción",
    // Límites
    limite_excedido: "Se superó el límite de peticiones por minuto de una ruta",
    // Acceso compartido entre empresas (acciones del administrador de plataforma o del Owner)
    acceso_compartido_concedido: "El maestro dio a una persona acceso a otra empresa",
    acceso_compartido_retirado: "Se retiró a una persona el acceso a una empresa",
});

/**
 * Escribe un evento de seguridad. `datos` completa o pisa el contexto de la petición (p. ej. el `usuario_id` de quien intentó entrar,
 * que aún no tiene sesión). Nunca pases aquí contraseñas, PIN ni tokens.
 */
export function registrarEvento(req, evento, datos = {}, nivel = "warn") {
    logger[nivel]("security", {
        evento,
        requestId: req?.id ?? null,
        ip: req?.ip ?? null,
        usuario_id: req?.user?.id ?? null,
        empresa_id: req?.user?.empresa_id ?? null,
        ...datos,
    });
}

// Un campo «correo» que alguien tecleó puede no serlo (la contraseña pegada en el campo equivocado): solo se registra si de verdad
// parece un correo y el enmascarador lo reconoce; si no, no queda nada de lo tecleado.
const PARECE_CORREO = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
export function correoParaLog(valor) {
    if (typeof valor !== "string" || !PARECE_CORREO.test(valor.trim())) return "[no es un correo]";
    const limpio = valor.trim().slice(0, 150);
    const enmascarado = enmascararCorreo(limpio);
    return enmascarado === limpio ? "[no es un correo]" : enmascarado;
}
