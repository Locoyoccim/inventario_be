import bcrypt from "bcryptjs";
import { signToken } from "../../utils/jwt.js";
import ApiError from "../../utils/ApiError.js";
import {
    contextoEmpresa,
    invalidarUsuarioActivo,
    perfilActivo,
    permisosEfectivos,
} from "../../middlewares/activeUser.js";
import { correoParaLog } from "../../utils/seguridad.js";

// Hash dummy (sin usuario real detrás) para que login() tarde lo mismo cuando el email no
// existe que cuando existe pero la contraseña es incorrecta — sin esto, la ausencia del
// bcrypt.compare en el camino "no existe" es medible y revela qué correos están registrados.
// Costo 10 a propósito: debe igualar el costo de los hashes YA almacenados (creados con
// bcrypt.hash(..., 10) antes de subir a 12 abajo); un dummy en costo 12 tardaría más que
// comparar contra un usuario real y reintroduciría el mismo timing leak al revés.
const HASH_DUMMY = "$2b$10$c/FzyZ996ndTpNk0UdNRnelYmxARV.QBfT.9gCgJs/1gjT1Vj6ZW2";

export default class AuthService {
    constructor(usuarioRepository, accesoRepository = null) {
        this.usuarioRepository = usuarioRepository;
        this.accesoRepository = accesoRepository;
    }

    // Empresas entre las que puede cambiar (la base y sus accesos vigentes). Vacío si solo tiene la suya: el front no muestra selector.
    async #empresasDisponibles(usuario_id, empresa_base_id, empresa_base_nombre) {
        const otras = this.accesoRepository
            ? await this.accesoRepository.opcionesDe(usuario_id)
            : [];
        if (!otras.length) return [];
        return [
            { id: Number(empresa_base_id), nombre: empresa_base_nombre, base: true },
            ...otras.map((o) => ({ id: Number(o.id), nombre: o.nombre, base: false })),
        ];
    }

    // Bootstrap del primer usuario: solo permitido si NO existe ningún usuario.
    async setup(data) {
        const total = await this.usuarioRepository.countAll();
        if (total > 0) {
            throw ApiError.forbidden("El setup ya fue realizado. Usa /api/auth/login.");
        }
        const password_hash = await bcrypt.hash(data.password, 12);
        const creado = await this.usuarioRepository.create(data.empresa_id, {
            nombre: data.nombre,
            codigo_ingreso: data.codigo_ingreso,
            puesto: data.puesto,
            role_id: data.role_id,
            email: data.email,
            password_hash,
            is_admin: true,
            is_owner: true,
        });
        const token = signToken({
            id: creado.id,
            empresa_id: creado.empresa_id,
            is_admin: true,
            is_owner: true,
            role_id: creado.role_id,
            tv: 0,
        });
        return { token, user: creado };
    }

    // Perfil fresco desde BD (nombre/email/rol pueden cambiar después de emitir el token). `user` es req.user ya refrescado por
    // requireActiveUser: su is_admin/is_owner/permisos son los de la empresa ACTIVA (la base o el acceso compartido), y
    // `empresa_base` es la de la fila de la persona.
    async profile(user) {
        const base = user.empresa_base ?? user.empresa_id;
        const u = await this.usuarioRepository.findProfile(base, user.id);
        if (!u || u.activo === false) return null;
        return await this.#perfilEn(u, Number(user.empresa_id), user);
    }

    // Arma el perfil de `u` (fila base) tal como lo ve en la empresa `empresa_id`. `ctx` = { is_admin, is_owner, permisos } de esa empresa.
    async #perfilEn(u, empresa_id, ctx) {
        const empresas = await this.#empresasDisponibles(u.id, u.empresa_id, u.empresa_nombre);
        const activa = empresas.find((e) => e.id === Number(empresa_id));
        return {
            id: u.id,
            nombre: u.nombre,
            email: u.email,
            empresa_id: Number(empresa_id),
            empresa_nombre: activa?.nombre ?? u.empresa_nombre,
            empresas,
            is_admin: ctx.is_admin,
            is_owner: ctx.is_owner,
            is_platform_admin: u.is_platform_admin,
            must_change_password: u.must_change_password,
            permisos: ctx.permisos,
        };
    }

    async login(email, password) {
        const u = await this.usuarioRepository.findByEmail(email);
        // Siempre se ejecuta un bcrypt.compare, exista o no el usuario: si el camino "no
        // existe" retornara antes de comparar, el tiempo de respuesta delataría qué correos
        // están registrados (mensaje de error genérico a propósito, por la misma razón).
        const ok = await bcrypt.compare(password, u?.password_hash ?? HASH_DUMMY);
        if (!u || !u.password_hash || !ok)
            // El motivo exacto solo se escribe en el log: la respuesta es la misma (no delata qué correos existen).
            throw ApiError.unauthorized("Credenciales inválidas").conEvento("login_fallido", {
                correo: correoParaLog(email),
                usuario_id: u?.id ?? null,
                motivo: !u
                    ? "usuario_inexistente"
                    : !u.password_hash
                      ? "sin_contrasena"
                      : "clave_incorrecta",
            });
        // Solo tras validar la contrasena, para no revelar que correos existen.
        if (u.activo === false)
            throw ApiError.forbidden("Usuario desactivado. Contacta al administrador.").conEvento(
                "login_bloqueado",
                { usuario_id: u.id, motivo: "usuario_desactivado" },
            );
        if (u.empresa_activa === false)
            throw ApiError.forbidden(
                "La empresa fue desactivada. Contacta al administrador.",
            ).conEvento("login_bloqueado", { usuario_id: u.id, motivo: "empresa_desactivada" });

        const token = signToken({
            id: u.id,
            empresa_id: u.empresa_id,
            is_admin: u.is_admin,
            is_owner: u.is_owner,
            is_platform_admin: u.is_platform_admin,
            role_id: u.role_id,
            tv: u.token_version ?? 0,
        });
        return {
            token,
            user: await this.#perfilEn(u, u.empresa_id, {
                is_admin: u.is_admin,
                is_owner: u.is_owner,
                permisos: permisosEfectivos(u.role_id, u.permisos),
            }),
        };
    }

    // Cambia la empresa ACTIVA de la sesión (la base o un acceso compartido vigente) y re-firma el token con ella: la sesión sigue
    // llevando UNA sola empresa, así que lo que sale de la API sigue siendo de una empresa a la vez. Conserva la caducidad original
    // y la versión de token (cerrar sesiones sigue cortando todo). Una sesión de PIN no puede cambiar de empresa.
    async cambiarEmpresa(user, destino_id) {
        if (user.pin)
            throw ApiError.forbidden(
                "Esta acción requiere entrar con correo y contraseña",
            ).conEvento("cambio_empresa_denegado", { motivo: "sesion_pin", destino: destino_id });
        const estado = await perfilActivo(user.id);
        const ctx = estado.activo ? contextoEmpresa(estado, destino_id) : null;
        if (!ctx)
            throw ApiError.forbidden("No tienes acceso a esa empresa").conEvento(
                "cambio_empresa_denegado",
                { motivo: "sin_acceso", destino: destino_id },
            );
        if (!ctx.empresa_activa)
            throw ApiError.forbidden(
                "Esa empresa está desactivada. Contacta al administrador.",
            ).conEvento("cambio_empresa_denegado", {
                motivo: "empresa_desactivada",
                destino: destino_id,
            });
        const base = estado.empresa_id;
        const u = await this.usuarioRepository.findProfile(base, user.id);
        if (!u) throw ApiError.unauthorized("El usuario ya no existe");
        // La caducidad es la de la sesión original (exp tal cual): cambiar de empresa no la extiende.
        const expiresIn = user.exp
            ? Math.max(1, Math.ceil(user.exp - Date.now() / 1000))
            : undefined;
        const token = signToken({
            id: user.id,
            empresa_id: Number(destino_id),
            is_admin: ctx.is_admin,
            is_owner: ctx.is_owner,
            is_platform_admin: estado.is_platform_admin,
            tv: estado.tv,
            ...(user.exp ? { exp: user.exp } : {}),
        });
        return { token, expiresIn, user: await this.#perfilEn(u, destino_id, ctx) };
    }

    // Cierra TODAS las sesiones del usuario: sube token_version (revoca los JWT vigentes).
    async logoutAll(user) {
        await this.usuarioRepository.bumpTokenVersion(
            user.empresa_base ?? user.empresa_id,
            user.id,
        );
        invalidarUsuarioActivo(user.id);
    }

    // Cambio de la propia contraseña (self-service). Siempre exige la contraseña actual,
    // incluso durante el cambio obligatorio por contraseña temporal: el usuario ya la conoce
    // (se la dio el administrador de plataforma), y exigirla evita que un JWT robado (sin la
    // contraseña) baste para tomar la cuenta. Revoca las demás sesiones, como cualquier
    // cambio de password.
    async changePassword(user, passwordActual, passwordNueva) {
        const hashActual = await this.usuarioRepository.findPasswordHash(
            user.empresa_base ?? user.empresa_id,
            user.id,
        );
        if (!hashActual) throw ApiError.unauthorized("No se pudo validar la cuenta");
        const ok = await bcrypt.compare(passwordActual, hashActual);
        if (!ok)
            throw ApiError.badRequest("La contraseña actual no es correcta").conEvento(
                "password_actual_incorrecta",
            );

        const password_hash = await bcrypt.hash(passwordNueva, 12);
        await this.usuarioRepository.updateOwnPassword(
            user.empresa_base ?? user.empresa_id,
            user.id,
            password_hash,
        );
        await this.usuarioRepository.bumpTokenVersion(
            user.empresa_base ?? user.empresa_id,
            user.id,
        );
        invalidarUsuarioActivo(user.id);
    }
}
