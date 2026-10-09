import ApiError from "../../utils/ApiError.js";
import { signToken } from "../../utils/jwt.js";
import { invalidarUsuarioActivo, permisosEfectivos } from "../../middlewares/activeUser.js";
import { esperaTotalSeg, hashPin, validarPin, verificarPin } from "./pin.logic.js";

export const duracionSesionPin = () => process.env.PIN_SESSION_EXPIRES || "12h";

// Ingreso con PIN desde un equipo registrado y administración de los PIN por un Admin.
export default class PinService {
    constructor(dispositivoRepository, usuarioRepository) {
        this.repo = dispositivoRepository;
        this.usuarios = usuarioRepository;
    }

    async personal(dispositivo) {
        return {
            dispositivo: { id: dispositivo.id, nombre: dispositivo.nombre },
            personal: await this.repo.personal(dispositivo.empresa_id),
        };
    }

    async entrar(dispositivo, { usuario_id, pin, ip }) {
        const u = await this.repo.usuarioParaPin(dispositivo.empresa_id, usuario_id);
        // Sin PIN, administradores y usuarios desactivados responden igual que un PIN equivocado (y sin registrar fallo).
        const elegible = Boolean(
            u &&
            u.activo !== false &&
            u.pin_hash &&
            !u.is_admin &&
            !u.is_owner &&
            !u.is_platform_admin &&
            !u.must_change_password,
        );

        if (elegible) {
            if (u.pin_bloqueado_at)
                throw ApiError.tooMany(
                    "PIN bloqueado por demasiados intentos. Pide a un administrador que lo desbloquee.",
                    { bloqueado: true },
                );
            const fallos = await this.repo.fallosRecientes(u.id, dispositivo.id, ip);
            const espera = esperaTotalSeg(fallos, fallos.ahoraMs);
            if (espera > 0)
                throw ApiError.tooMany(
                    `Demasiados intentos. Espera ${Math.ceil(espera / 60)} min e inténtalo de nuevo.`,
                    { espera_seg: espera },
                );
        }

        // Siempre se compara contra un hash (dummy si no hay PIN) para que el tiempo no delate nada.
        const ok = await verificarPin(u?.id ?? 0, String(pin), elegible ? u.pin_hash : null);
        if (!elegible || !ok) {
            if (elegible)
                await this.repo.registrarFallo(dispositivo.empresa_id, u.id, dispositivo.id, ip);
            throw ApiError.unauthorized("PIN incorrecto");
        }

        await this.repo.limpiarFallos(u.id, dispositivo.id);
        await this.repo.marcarUso(dispositivo.id);
        const expires = duracionSesionPin();
        const token = signToken(
            {
                id: u.id,
                empresa_id: u.empresa_id,
                is_admin: false,
                is_owner: false,
                is_platform_admin: false,
                role_id: u.role_id,
                tv: u.token_version ?? 0,
                pin: true,
                disp: dispositivo.id,
            },
            expires,
        );
        return {
            token,
            expires,
            user: {
                id: u.id,
                nombre: u.nombre,
                email: u.email,
                empresa_id: u.empresa_id,
                is_admin: false,
                is_owner: false,
                is_platform_admin: false,
                must_change_password: false,
                permisos: permisosEfectivos(u.role_id, u.permisos),
            },
        };
    }

    async definirPin(empresa_id, usuario_id, pin) {
        const problema = validarPin(pin);
        if (problema) throw ApiError.badRequest(problema);
        await this.repo.guardarPin(empresa_id, usuario_id, await hashPin(usuario_id, pin));
    }

    // Quitar el PIN cierra también las sesiones abiertas del usuario: quien lo tenía no sigue dentro.
    async quitarPin(empresa_id, usuario_id) {
        await this.repo.quitarPin(empresa_id, usuario_id);
        await this.usuarios.bumpTokenVersion(empresa_id, usuario_id);
        invalidarUsuarioActivo(usuario_id);
    }

    async desbloquear(empresa_id, usuario_id) {
        await this.repo.desbloquear(empresa_id, usuario_id);
    }
}
