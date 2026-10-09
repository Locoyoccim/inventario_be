import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { puedeAutorizarUsuario, resolverAutorizador } from "./pos.autorizacion.js";

const puedeAutorizar = (req) => puedeAutorizarUsuario(req.user);
const exigir = (a) => {
    if (!a.autorizador_id)
        throw ApiError.forbidden("Esta acción requiere la autorización de un supervisor");
    return a;
};
const usuarioTurno = (req) => ({ id: req.user.id, puedeAutorizar: puedeAutorizar(req) });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export default class PosController {
    constructor(cuentas, impresion, turnos, ajustes, comandas) {
        this.cuentas = cuentas;
        this.comandas = comandas;
        this.impresion = impresion;
        this.turnos = turnos;
        this.ajustes = ajustes;
    }

    // Quién autoriza: el propio usuario si tiene permiso, o el supervisor cuyas credenciales vengan en el cuerpo.
    // Si no hay ninguno devuelve null y la operación decide si lo exige. Las credenciales nunca llegan al repositorio.
    async #autorizacion(req) {
        const actor = { id: req.user.id, puedeAutorizar: puedeAutorizar(req) };
        const autorizador_id = await resolverAutorizador(
            req.params.empresa_id,
            actor,
            req.body?.autorizacion,
        );
        return { autorizador_id, solicitante_id: req.user.id };
    }

    // ---- Mesas y cuentas ----
    mapa = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.mapa(req.params.empresa_id)),
    );
    obtener = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.obtener(req.params.empresa_id, req.params.id)),
    );
    abrir = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.abrirCuenta(req.params.empresa_id, req.body, req.user.id), 201),
    );
    agregarItems = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.agregarItems(
                req.params.empresa_id,
                req.params.id,
                req.body.lineas,
                req.user.id,
            ),
            201,
        ),
    );
    actualizarItem = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.actualizarItem(
                req.params.empresa_id,
                req.params.id,
                req.params.itemId,
                req.body,
            ),
        ),
    );
    eliminarItem = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.eliminarItem(
                req.params.empresa_id,
                req.params.id,
                req.params.itemId,
            ),
        ),
    );
    cancelarItem = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.cancelarItem(
                req.params.empresa_id,
                req.params.id,
                req.params.itemId,
                req.body.motivo,
                { ...(await this.#autorizacion(req)), merma: req.body.merma === true },
            ),
        ),
    );
    descuentoItem = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.ajustes.descuentoItem(
                req.params.empresa_id,
                req.params.id,
                req.params.itemId,
                req.body,
                exigir(await this.#autorizacion(req)),
            ),
        ),
    );
    descuentoCuenta = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.ajustes.descuentoCuenta(
                req.params.empresa_id,
                req.params.id,
                req.body,
                exigir(await this.#autorizacion(req)),
            ),
        ),
    );
    anular = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.ajustes.anular(
                req.params.empresa_id,
                req.params.id,
                req.body,
                exigir(await this.#autorizacion(req)),
            ),
        ),
    );
    corregirPago = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.ajustes.corregirPago(
                req.params.empresa_id,
                req.params.id,
                req.body,
                exigir(await this.#autorizacion(req)),
            ),
        ),
    );
    enviar = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.enviar(
                req.params.empresa_id,
                req.params.id,
                req.user.id,
                req.body?.tiempo ?? 1,
            ),
        ),
    );
    descartarCuenta = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.descartar(req.params.empresa_id, req.params.id)),
    );
    actualizarCuenta = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.actualizar(req.params.empresa_id, req.params.id, req.body)),
    );
    cambiarMesa = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.cambiarMesa(req.params.empresa_id, req.params.id, req.body.mesa_id),
        ),
    );
    juntar = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.juntar(
                req.params.empresa_id,
                Number(req.params.id),
                req.body.destino_id,
            ),
        ),
    );
    dividir = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.dividir(
                req.params.empresa_id,
                req.params.id,
                req.body.partes,
                req.user.id,
            ),
        ),
    );
    cancelarCuenta = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.cancelarCuenta(req.params.empresa_id, req.params.id, {
                motivo: req.body.motivo,
                merma: req.body.merma === true,
                ...(await this.#autorizacion(req)),
            }),
        ),
    );
    precuenta = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.precuenta(req.params.empresa_id, req.params.id, req.user.id)),
    );

    cobrar = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.cobrar(
                req.params.empresa_id,
                req.params.id,
                req.body.pagos,
                req.user.id,
            ),
        ),
    );
    reimprimirTicket = asyncHandler(async (req, res) => {
        const trabajo = await this.cuentas.ultimoTicket(req.params.empresa_id, req.params.id);
        ok(res, await this.impresion.reimprimir(req.params.empresa_id, trabajo.id));
    });

    // ---- Pantalla de cocina (opcional) ----
    comandasActivas = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.comandas.activas(
                req.params.empresa_id,
                req.query.area_id ? Number(req.query.area_id) : null,
            ),
        ),
    );
    // Preparar y dejar lista es de cocina (`pos.preparar`); marcarla entregada también la hace el mesero (`pos.ordenar`).
    estadoComanda = asyncHandler(async (req, res) => {
        const tiene = (clave) =>
            req.user.is_owner || req.user.is_admin || req.user.permisos?.includes(clave);
        const { estado } = req.body;
        if (
            estado === "ENTREGADA"
                ? !(tiene("pos.preparar") || tiene("pos.ordenar"))
                : !tiene("pos.preparar")
        )
            throw ApiError.forbidden("Tu rol no tiene permiso para esta acción").conEvento(
                "permiso_denegado",
                { requiere: "pos.preparar" },
            );
        ok(res, await this.comandas.cambiarEstado(req.params.empresa_id, req.params.id, estado));
    });

    // ---- Caja ----
    abrirTurno = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.cuentas.abrirTurno(
                req.params.empresa_id,
                req.user.id,
                req.body.fondo_inicial,
            ),
            201,
        ),
    );
    turnoAbierto = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.turnoAbierto(req.params.empresa_id, req.user.id)),
    );
    turnoActual = asyncHandler(async (req, res) =>
        ok(res, await this.cuentas.turnoActual(req.params.empresa_id, req.user.id)),
    );

    listarTurnos = asyncHandler(async (req, res) =>
        ok(res, await this.turnos.listar(req.params.empresa_id, usuarioTurno(req))),
    );
    corte = asyncHandler(async (req, res) =>
        ok(res, await this.turnos.corte(req.params.empresa_id, req.params.id, usuarioTurno(req))),
    );
    cerrarTurno = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.turnos.cerrar(
                req.params.empresa_id,
                req.params.id,
                req.body,
                usuarioTurno(req),
            ),
        ),
    );
    imprimirCorte = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.turnos.imprimirCorte(
                req.params.empresa_id,
                req.params.id,
                usuarioTurno(req),
            ),
            201,
        ),
    );

    // ---- Impresión (administración) ----
    impresoras = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.listarImpresoras(req.params.empresa_id)),
    );
    crearImpresora = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.crearImpresora(req.params.empresa_id, req.body), 201),
    );
    actualizarImpresora = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.impresion.actualizarImpresora(
                req.params.empresa_id,
                req.params.id,
                req.body,
            ),
        ),
    );
    imprimirPrueba = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.imprimirPrueba(req.params.empresa_id, req.params.id), 201),
    );
    agentes = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.listarAgentes(req.params.empresa_id)),
    );
    crearAgente = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.crearAgente(req.params.empresa_id, req.body.nombre), 201),
    );
    actualizarAgente = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.impresion.actualizarAgente(req.params.empresa_id, req.params.id, req.body),
        ),
    );
    eliminarAgente = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.eliminarAgente(req.params.empresa_id, req.params.id)),
    );
    rotarToken = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.rotarToken(req.params.empresa_id, req.params.id)),
    );
    codigoAgente = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.nuevoCodigo(req.params.empresa_id, req.params.id)),
    );
    // Versión publicada del agente y dónde bajar el instalador, más el último fallo de impresión (diagnóstico).
    agentesInfo = asyncHandler(async (req, res) =>
        ok(res, {
            manifiesto: this.impresion.manifiesto(),
            ultimo_error: await this.impresion.ultimoError(req.params.empresa_id),
        }),
    );

    // Público (lo usa el instalador): canjea el código de emparejamiento por un token nuevo. `servidor` es la dirección a la que
    // el agente debe llamar; PUBLIC_API_URL la fija cuando el servidor está detrás de otro dominio.
    emparejarAgente = asyncHandler(async (req, res) => {
        const r = await this.impresion.emparejar(req.body.codigo, req.body.equipo);
        const servidor = (
            process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`
        ).replace(/\/+$/, "");
        ok(res, { servidor, token: r.token, zona_horaria: r.zona_horaria, agente: r.agente });
    });

    // Lado del agente (con su token): manifiesto de versión para actualizarse solo.
    agenteVersion = asyncHandler(async (_req, res) =>
        ok(res, { manifiesto: this.impresion.manifiesto() }),
    );
    estadoImpresion = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.estado(req.params.empresa_id)),
    );
    cola = asyncHandler(async (req, res) => {
        const estado = [
            "PENDIENTE",
            "IMPRIMIENDO",
            "IMPRESO",
            "ERROR",
            "SIN_IMPRESORA",
            "DESCARTADA",
        ].includes(req.query.estado)
            ? req.query.estado
            : null;
        ok(res, await this.impresion.cola(req.params.empresa_id, { estado }));
    });
    descartarImpresion = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.impresion.descartar(
                req.params.empresa_id,
                Number(req.params.id),
                req.user.id,
            ),
        ),
    );
    descartarImpresiones = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.impresion.descartarVarios(
                req.params.empresa_id,
                req.user.id,
                req.body.estados,
            ),
        ),
    );
    reimprimir = asyncHandler(async (req, res) =>
        ok(res, await this.impresion.reimprimir(req.params.empresa_id, req.params.id)),
    );
    // El corte lleva cifras de caja: solo quien puede cobrar lo ve o lo imprime desde el navegador.
    async #jobPermitido(req) {
        const job = await this.impresion.obtener(req.params.empresa_id, req.params.id);
        const u = req.user;
        if (
            job.tipo === "CORTE" &&
            !(u?.is_owner || u?.is_admin || u?.permisos?.includes("pos.cobrar"))
        )
            throw ApiError.forbidden("Tu rol no tiene permiso para esta acción").conEvento(
                "permiso_denegado",
                { requiere: "pos.cobrar" },
            );
        return job;
    }
    impresion_ = asyncHandler(async (req, res) => ok(res, await this.#jobPermitido(req)));
    impresoNavegador = asyncHandler(async (req, res) => {
        await this.#jobPermitido(req);
        ok(res, await this.impresion.marcarImpresoNavegador(req.params.empresa_id, req.params.id));
    });

    // ---- Lado del agente (autenticado por token del agente, no por cookie de usuario) ----
    agentePendientes = asyncHandler(async (req, res) => {
        await this.impresion.registrarContacto(
            req.agente.id,
            String(req.headers["x-agent-version"] ?? "").slice(0, 20) || null,
        );
        ok(res, await this.impresion.reclamarPendientes(req.agente.empresa_id));
    });
    agenteResultado = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.impresion.resultado(req.agente.empresa_id, Number(req.params.id), req.body),
        ),
    );

    requireAgente = asyncHandler(async (req, _res, next) => {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (!token)
            throw ApiError.unauthorized("Falta el token del agente").conEvento(
                "agente_token_invalido",
                {
                    motivo: "sin_token",
                },
            );
        const agente = await this.impresion.autenticarAgente(token);
        if (!agente)
            throw ApiError.unauthorized("Token de agente inválido o desactivado").conEvento(
                "agente_token_invalido",
                { motivo: "invalido_o_desactivado" },
            );
        req.agente = agente;
        next();
    });
}
