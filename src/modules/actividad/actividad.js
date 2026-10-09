import pool from "../../config/db.js";
import logger from "../../utils/logger.js";
import { limpiarContexto } from "../../utils/redactar.js";
import { insertarActividad } from "./actividad.repository.js";

// Bitácora de acciones administrativas (ADR-009): quién hizo qué, sobre qué, cuándo y desde dónde. Los NOMBRES de acción son un contrato
// estable (se buscan, se filtran y se enseñarán en pantalla): se pueden añadir, no renombrar. `docs/OBSERVABILIDAD.md` los documenta y una
// prueba exige que el catálogo, el código y el documento estén de acuerdo.
export const ACCIONES = Object.freeze({
    // Usuarios de la empresa
    "usuario.crear": "Se dio de alta a un usuario",
    "usuario.actualizar":
        "Se cambió un usuario (rol, estado, correo, contraseña, cierre de sesiones…)",
    // PIN y equipos
    "pin.definir": "Se definió o cambió el PIN de un usuario",
    "pin.quitar": "Se quitó el PIN de un usuario",
    "pin.desbloquear": "Se desbloqueó el PIN de un usuario",
    "equipo.crear": "Se registró un equipo nuevo (con su código de un solo uso)",
    "equipo.actualizar": "Se renombró un equipo",
    "equipo.codigo_nuevo": "Se generó un código nuevo para un equipo",
    "equipo.revocar": "Se revocó un equipo",
    // Agentes de impresión
    "agente.crear": "Se creó un agente de impresión",
    "agente.actualizar": "Se cambió un agente de impresión (nombre o estado)",
    "agente.eliminar": "Se eliminó un agente de impresión",
    "agente.rotar_token": "Se renovó el token de un agente",
    "agente.codigo": "Se generó un código de emparejamiento para un agente",
    // Acceso compartido entre empresas
    "acceso.conceder": "El maestro dio a una persona acceso a otra empresa",
    "acceso.retirar": "Se retiró a una persona el acceso a una empresa",
    // Plataforma (usuario maestro)
    "plataforma.empresa_crear": "El maestro creó una empresa con su Owner",
    "plataforma.empresa_estado": "El maestro activó o desactivó una empresa",
    "plataforma.invitacion_reenviar": "El maestro reenvió la invitación de un Owner",
    "plataforma.owner_password_resetear": "El maestro restableció la contraseña de un Owner",
    // Empresa
    "empresa.configuracion_actualizar": "Se cambió la configuración de la empresa",
});

/** Lo que identifica a quien hace la petición y desde dónde: sale de `req` (nunca del cuerpo de la petición). */
export function contextoActividad(req) {
    return {
        actor_id: req.user?.id ?? null,
        actor_empresa_id: req.user?.empresa_id ?? null,
        ip: req.ip ?? null,
        request_id: req.id ?? null,
    };
}

/**
 * Escribe una fila. `db` es el pool o el cliente de una transacción: con un cliente, la fila entra o sale junto con la acción.
 * `detalle` solo admite datos sin secretos (ids, nombres de campos, banderas); aun así pasa por el saneador del log.
 */
export async function registrarActividad(
    db,
    ctx,
    { empresa_id, accion, objeto_tipo, objeto_id = null, detalle = {} },
) {
    if (!(accion in ACCIONES)) throw new Error(`Acción de actividad desconocida: ${accion}`);
    return await insertarActividad(db, {
        empresa_id: Number(empresa_id),
        actor_id: ctx.actor_id ?? null,
        actor_empresa_id: ctx.actor_empresa_id ?? null,
        accion,
        objeto_tipo,
        objeto_id: objeto_id === null || objeto_id === undefined ? null : Number(objeto_id),
        detalle: limpiarContexto(detalle),
        ip: ctx.ip ?? null,
        request_id: ctx.request_id ?? null,
    });
}

/**
 * Para acciones SIN transacción propia: se escribe justo después de que la acción tuvo éxito. Si la bitácora falla, la acción ya hecha NO
 * se deshace (el usuario no puede reintentar algo que ya ocurrió) y el fallo queda como `admin_actividad_fallida` en el log.
 */
export async function registrarActividadSegura(req, datos) {
    try {
        await registrarActividad(pool, contextoActividad(req), datos);
    } catch (error) {
        logger.error("admin_actividad_fallida", {
            accion: datos?.accion,
            empresa_id: datos?.empresa_id,
            requestId: req?.id,
            error: error?.message ?? String(error),
        });
    }
}
