import rateLimit from "express-rate-limit";
import { validate } from "../middlewares/validate.js";
import { conIdempotencia } from "../utils/idempotencia.js";
import { eventosSSE } from "../realtime/eventosPos.sse.js";
import { requireAdmin, requirePermiso } from "../middlewares/auth.js";
import { posConfigController, posController, posOpcionesController } from "../container.js";
import {
    areaCreateSchema, areaUpdateSchema, mesaCreateSchema, mesaUpdateSchema, asignarAreaSchema,
} from "../modules/pos/posConfig.schema.js";
import {
    cuentaCreateSchema, cuentaUpdateSchema, itemsCreateSchema, itemUpdateSchema, motivoSchema, cancelarCuentaSchema, cambiarMesaSchema, juntarSchema, dividirSchema, cobroSchema, corregirPagoSchema, descuentoSchema, anularSchema,
    turnoAbrirSchema, turnoCerrarSchema, estadoComandaSchema, descartarImpresionesSchema, enviarSchema, grupoOpcionesSchema, impresoraCreateSchema, impresoraUpdateSchema, agenteCreateSchema, agenteUpdateSchema,
} from "../modules/pos/pos.schema.js";

export default function registerPos(router) {
    const b = "/pos/:empresa_id";
    const ver = requirePermiso("pos.ver");
    const ordenar = requirePermiso("pos.ordenar");
    const cobrar = requirePermiso("pos.cobrar");
    const autorizar = requirePermiso("pos.autorizar");
    // Las credenciales de supervisor viajan en el cuerpo: se limitan los intentos por usuario (anti fuerza bruta).
    const intentos = rateLimit({
        windowMs: 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
        skip: (req) => process.env.NODE_ENV === "test" || !req.body?.autorizacion,
        keyGenerator: (req) => `u${req.user?.id}`,
        message: { success: false, error: "Demasiados intentos de autorización. Espera un minuto." },
    });

    // Configuración
    router.get(`${b}/areas`, ver, posConfigController.listarAreas);
    router.post(`${b}/areas`, requireAdmin, validate(areaCreateSchema), posConfigController.crearArea);
    router.put(`${b}/areas/:id`, requireAdmin, validate(areaUpdateSchema), posConfigController.actualizarArea);
    router.get(`${b}/mesas`, ver, posConfigController.listarMesas);
    router.post(`${b}/mesas`, requireAdmin, validate(mesaCreateSchema), posConfigController.crearMesa);
    router.put(`${b}/mesas/:id`, requireAdmin, validate(mesaUpdateSchema), posConfigController.actualizarMesa);
    router.delete(`${b}/mesas/:id`, requireAdmin, posConfigController.eliminarMesa);
    router.get(`${b}/asignacion-areas`, requireAdmin, posConfigController.listarAsignacion);
    router.put(`${b}/asignacion-areas/categoria/:id`, requireAdmin, validate(asignarAreaSchema), posConfigController.asignarAreaCategoria);
    router.put(`${b}/asignacion-areas/:tipo/:id`, requireAdmin, validate(asignarAreaSchema), posConfigController.asignarAreaArticulo);
    router.get(`${b}/menu`, ver, posConfigController.menu);

    // Opciones por producto (grupos, opciones y a qué artículos se ofrecen)
    router.get(`${b}/opciones`, requireAdmin, posOpcionesController.listar);
    router.post(`${b}/opciones`, requireAdmin, validate(grupoOpcionesSchema), posOpcionesController.crear);
    router.put(`${b}/opciones/:id`, requireAdmin, validate(grupoOpcionesSchema), posOpcionesController.actualizar);
    router.delete(`${b}/opciones/:id`, requireAdmin, posOpcionesController.desactivar);

    // Operación de mesas y cuentas
    router.get(`${b}/mapa`, ver, posController.mapa);
    router.post(`${b}/cuentas`, ordenar, validate(cuentaCreateSchema), ...conIdempotencia(posController.abrir));
    router.get(`${b}/cuentas/:id`, ver, posController.obtener);
    router.post(`${b}/cuentas/:id/descartar`, ordenar, posController.descartarCuenta);
    router.patch(`${b}/cuentas/:id`, ordenar, validate(cuentaUpdateSchema), posController.actualizarCuenta);
    router.post(`${b}/cuentas/:id/items`, ordenar, validate(itemsCreateSchema), ...conIdempotencia(posController.agregarItems));
    router.put(`${b}/cuentas/:id/items/:itemId`, ordenar, validate(itemUpdateSchema), posController.actualizarItem);
    router.delete(`${b}/cuentas/:id/items/:itemId`, ordenar, posController.eliminarItem);
    router.post(`${b}/cuentas/:id/items/:itemId/cancelar`, ordenar, validate(motivoSchema), intentos, posController.cancelarItem);
    router.post(`${b}/cuentas/:id/items/:itemId/descuento`, ordenar, validate(descuentoSchema), intentos, posController.descuentoItem);
    router.post(`${b}/cuentas/:id/descuento`, ordenar, validate(descuentoSchema), intentos, posController.descuentoCuenta);
    router.post(`${b}/cuentas/:id/corregir-pago`, cobrar, validate(corregirPagoSchema), intentos, posController.corregirPago);
    router.post(`${b}/cuentas/:id/anular`, cobrar, validate(anularSchema), intentos, posController.anular);
    router.post(`${b}/cuentas/:id/enviar`, ordenar, validate(enviarSchema), ...conIdempotencia(posController.enviar));
    router.post(`${b}/cuentas/:id/cambiar-mesa`, ordenar, validate(cambiarMesaSchema), posController.cambiarMesa);
    router.post(`${b}/cuentas/:id/juntar`, ordenar, validate(juntarSchema), posController.juntar);
    router.post(`${b}/cuentas/:id/dividir`, ordenar, validate(dividirSchema), posController.dividir);
    router.post(`${b}/cuentas/:id/precuenta`, ordenar, posController.precuenta);
    router.post(`${b}/cuentas/:id/cobrar`, cobrar, validate(cobroSchema), ...conIdempotencia(posController.cobrar));
    router.post(`${b}/cuentas/:id/ticket`, ordenar, posController.reimprimirTicket);
    router.post(`${b}/cuentas/:id/cancelar`, ordenar, validate(cancelarCuentaSchema), intentos, posController.cancelarCuenta);

    // Avisos en tiempo real (SSE): el front vuelve a pedir lo que cambió; el polling queda como respaldo.
    router.get(`${b}/eventos`, ver, eventosSSE);

    // Pantalla de cocina (opcional)
    router.get(`${b}/comandas/activas`, requirePermiso("pos.preparar"), posController.comandasActivas);
    router.post(`${b}/comandas/:id/estado`, ver, validate(estadoComandaSchema), posController.estadoComanda);

    // Caja
    router.get(`${b}/turnos/actual`, ver, posController.turnoActual);
    router.post(`${b}/turnos/abrir`, cobrar, validate(turnoAbrirSchema), posController.abrirTurno);
    router.get(`${b}/turnos`, cobrar, posController.listarTurnos);
    router.get(`${b}/turnos/:id/corte`, cobrar, posController.corte);
    router.post(`${b}/turnos/:id/cerrar`, cobrar, validate(turnoCerrarSchema), posController.cerrarTurno);
    router.post(`${b}/turnos/:id/corte/imprimir`, cobrar, posController.imprimirCorte);

    // Impresión
    router.get(`${b}/impresion/estado`, ver, posController.estadoImpresion);
    router.get(`${b}/impresiones`, autorizar, posController.cola);
    router.post(`${b}/impresiones/descartar`, autorizar, validate(descartarImpresionesSchema), posController.descartarImpresiones);
    router.post(`${b}/impresiones/:id/descartar`, autorizar, posController.descartarImpresion);
    router.post(`${b}/impresiones/:id/reimprimir`, ordenar, posController.reimprimir);
    router.get(`${b}/impresiones/:id`, ordenar, posController.impresion_);
    router.post(`${b}/impresiones/:id/impreso-navegador`, ordenar, posController.impresoNavegador);
    router.get(`${b}/impresoras`, requireAdmin, posController.impresoras);
    router.post(`${b}/impresoras`, requireAdmin, validate(impresoraCreateSchema), posController.crearImpresora);
    router.put(`${b}/impresoras/:id`, requireAdmin, validate(impresoraUpdateSchema), posController.actualizarImpresora);
    router.post(`${b}/impresoras/:id/prueba`, requireAdmin, posController.imprimirPrueba);
    router.get(`${b}/agentes`, requireAdmin, posController.agentes);
    router.post(`${b}/agentes`, requireAdmin, validate(agenteCreateSchema), posController.crearAgente);
    router.put(`${b}/agentes/:id`, requireAdmin, validate(agenteUpdateSchema), posController.actualizarAgente);
    router.delete(`${b}/agentes/:id`, requireAdmin, posController.eliminarAgente);
    router.post(`${b}/agentes/:id/rotar-token`, requireAdmin, posController.rotarToken);
    router.post(`${b}/agentes/:id/codigo`, requireAdmin, posController.codigoAgente);
    router.get(`${b}/agentes-info`, requireAdmin, posController.agentesInfo);
}
