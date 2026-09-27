import bcrypt from "bcryptjs";
import { signToken } from "../../utils/jwt.js";
import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";

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
        const password_hash = await bcrypt.hash(data.password, 10);
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
        };
    }

    async login(email, password) {
        const u = await this.usuarioRepository.findByEmail(email);
        // Mensaje genérico a propósito (no revelar si el correo existe)
        if (!u || !u.password_hash) throw ApiError.unauthorized("Credenciales inválidas");
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) throw ApiError.unauthorized("Credenciales inválidas");
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

        const password_hash = await bcrypt.hash(passwordNueva, 10);
        await this.usuarioRepository.updateOwnPassword(user.empresa_id, user.id, password_hash);
        await this.usuarioRepository.bumpTokenVersion(user.empresa_id, user.id);
        invalidarUsuarioActivo(user.id);
    }
}
