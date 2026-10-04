import bcrypt from "bcryptjs";
import { signToken } from "../../utils/jwt.js";
import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo, permisosEfectivos } from "../../middlewares/activeUser.js";

// Hash dummy (sin usuario real detrás) para que login() tarde lo mismo cuando el email no
// existe que cuando existe pero la contraseña es incorrecta — sin esto, la ausencia del
// bcrypt.compare en el camino "no existe" es medible y revela qué correos están registrados.
// Costo 10 a propósito: debe igualar el costo de los hashes YA almacenados (creados con
// bcrypt.hash(..., 10) antes de subir a 12 abajo); un dummy en costo 12 tardaría más que
// comparar contra un usuario real y reintroduciría el mismo timing leak al revés.
const HASH_DUMMY = "$2b$10$c/FzyZ996ndTpNk0UdNRnelYmxARV.QBfT.9gCgJs/1gjT1Vj6ZW2";

export default class AuthService {
    constructor(usuarioRepository) {
        this.usuarioRepository = usuarioRepository;
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
            id: creado.id, empresa_id: creado.empresa_id,
            is_admin: true, is_owner: true, role_id: creado.role_id, tv: 0,
        });
        return { token, user: creado };
    }

    // Perfil fresco desde BD (nombre/email/rol pueden cambiar después de emitir el token).
    async profile(payload) {
        const u = await this.usuarioRepository.findProfile(payload.empresa_id, payload.id);
        if (!u || u.activo === false) return null;
        return {
            id: u.id, nombre: u.nombre, email: u.email,
            empresa_id: u.empresa_id, is_admin: u.is_admin, is_owner: u.is_owner,
            is_platform_admin: u.is_platform_admin, must_change_password: u.must_change_password,
            permisos: permisosEfectivos(u.role_id, u.permisos),
        };
    }

    async login(email, password) {
        const u = await this.usuarioRepository.findByEmail(email);
        // Siempre se ejecuta un bcrypt.compare, exista o no el usuario: si el camino "no
        // existe" retornara antes de comparar, el tiempo de respuesta delataría qué correos
        // están registrados (mensaje de error genérico a propósito, por la misma razón).
        const ok = await bcrypt.compare(password, u?.password_hash ?? HASH_DUMMY);
        if (!u || !u.password_hash || !ok) throw ApiError.unauthorized("Credenciales inválidas");
        // Solo tras validar la contrasena, para no revelar que correos existen.
        if (u.activo === false) throw ApiError.forbidden("Usuario desactivado. Contacta al administrador.");
        if (u.empresa_activa === false) throw ApiError.forbidden("La empresa fue desactivada. Contacta al administrador.");

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
            user: {
                id: u.id, nombre: u.nombre, email: u.email,
                empresa_id: u.empresa_id, is_admin: u.is_admin, is_owner: u.is_owner,
                is_platform_admin: u.is_platform_admin, must_change_password: u.must_change_password,
                permisos: permisosEfectivos(u.role_id, u.permisos),
            },
        };
    }

    // Cierra TODAS las sesiones del usuario: sube token_version (revoca los JWT vigentes).
    async logoutAll(user) {
        await this.usuarioRepository.bumpTokenVersion(user.empresa_id, user.id);
        invalidarUsuarioActivo(user.id);
    }

    // Cambio de la propia contraseña (self-service). Siempre exige la contraseña actual,
    // incluso durante el cambio obligatorio por contraseña temporal: el usuario ya la conoce
    // (se la dio el administrador de plataforma), y exigirla evita que un JWT robado (sin la
    // contraseña) baste para tomar la cuenta. Revoca las demás sesiones, como cualquier
    // cambio de password.
    async changePassword(user, passwordActual, passwordNueva) {
        const hashActual = await this.usuarioRepository.findPasswordHash(user.empresa_id, user.id);
        if (!hashActual) throw ApiError.unauthorized("No se pudo validar la cuenta");
        const ok = await bcrypt.compare(passwordActual, hashActual);
        if (!ok) throw ApiError.badRequest("La contraseña actual no es correcta");

        const password_hash = await bcrypt.hash(passwordNueva, 12);
        await this.usuarioRepository.updateOwnPassword(user.empresa_id, user.id, password_hash);
        await this.usuarioRepository.bumpTokenVersion(user.empresa_id, user.id);
        invalidarUsuarioActivo(user.id);
    }
}
