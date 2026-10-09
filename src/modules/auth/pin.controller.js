import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { invalidarDispositivo } from "../../middlewares/activeUser.js";
import {
    AUTH_COOKIE,
    CSRF_HEADER,
    DEVICE_COOKIE,
    authCookieOptions,
    clearDeviceCookieOptions,
    deviceCookieOptions,
    readCookie,
} from "../../utils/authCookie.js";

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Las rutas con la cookie del equipo exigen el header anti-CSRF aunque no haya sesión: así otro sitio no puede iniciar sesión
// «a ciegas» en el navegador de la persona con un PIN que conozca.
export function exigirCabeceraCsrf(req, _res, next) {
    if (!req.headers[CSRF_HEADER])
        return next(ApiError.forbidden("Falta el header X-Requested-With"));
    next();
}

/** Ingreso con PIN (público, con la cookie del equipo) y administración de equipos y PIN (Admin). */
export default class PinController {
    constructor(pinService, dispositivoRepository) {
        this.pin = pinService;
        this.dispositivos = dispositivoRepository;
    }

    // Resuelve el equipo de la cookie; si no hay o fue revocado, borra la cookie para que el front muestre el ingreso normal.
    async #dispositivo(req, res) {
        const token = readCookie(req.headers.cookie, DEVICE_COOKIE);
        const d = token ? await this.dispositivos.porToken(token) : null;
        if (!d) {
            if (token) res.clearCookie(DEVICE_COOKIE, clearDeviceCookieOptions());
            throw ApiError.unauthorized("Este equipo no está registrado");
        }
        return d;
    }

    // ---- Público ----
    registrarEquipo = asyncHandler(async (req, res) => {
        const { dispositivo, token } = await this.dispositivos.canjearCodigo(req.body.codigo);
        res.cookie(DEVICE_COOKIE, token, deviceCookieOptions());
        ok(res, { nombre: dispositivo.nombre });
    });

    personal = asyncHandler(async (req, res) => {
        ok(res, await this.pin.personal(await this.#dispositivo(req, res)));
    });

    entrar = asyncHandler(async (req, res) => {
        const dispositivo = await this.#dispositivo(req, res);
        const { token, expires, user } = await this.pin.entrar(dispositivo, {
            usuario_id: req.body.usuario_id,
            pin: req.body.pin,
            ip: req.ip,
        });
        res.cookie(AUTH_COOKIE, token, authCookieOptions(process.env, expires));
        ok(res, { user });
    });

    // ---- Admin ----
    listarEquipos = asyncHandler(async (req, res) =>
        ok(res, await this.dispositivos.listar(req.params.empresa_id)),
    );

    crearEquipo = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.dispositivos.crear(req.params.empresa_id, req.body.nombre, req.user.id),
            201,
        ),
    );

    renombrarEquipo = asyncHandler(async (req, res) =>
        ok(
            res,
            await this.dispositivos.renombrar(
                req.params.empresa_id,
                req.params.id,
                req.body.nombre,
            ),
        ),
    );

    codigoNuevo = asyncHandler(async (req, res) =>
        ok(res, await this.dispositivos.nuevoCodigo(req.params.empresa_id, req.params.id)),
    );

    revocarEquipo = asyncHandler(async (req, res) => {
        const d = await this.dispositivos.revocar(req.params.empresa_id, req.params.id);
        invalidarDispositivo(d.id);
        ok(res, d);
    });

    definirPin = asyncHandler(async (req, res) => {
        await this.pin.definirPin(req.params.empresa_id, Number(req.params.id), req.body.pin);
        ok(res, null);
    });

    quitarPin = asyncHandler(async (req, res) => {
        await this.pin.quitarPin(req.params.empresa_id, Number(req.params.id));
        ok(res, null);
    });

    desbloquearPin = asyncHandler(async (req, res) => {
        await this.pin.desbloquear(req.params.empresa_id, Number(req.params.id));
        ok(res, null);
    });
}
