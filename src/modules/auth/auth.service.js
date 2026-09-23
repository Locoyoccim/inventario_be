import bcrypt from "bcryptjs";
import { signToken } from "../../utils/jwt.js";
import ApiError from "../../utils/ApiError.js";

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
            is_admin: true, is_owner: true, role_id: creado.role_id,
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

        const token = signToken({
            id: u.id,
            empresa_id: u.empresa_id,
            is_admin: u.is_admin,
            is_owner: u.is_owner,
            role_id: u.role_id,
        });
        return {
            token,
            user: {
                id: u.id, nombre: u.nombre, email: u.email,
                empresa_id: u.empresa_id, is_admin: u.is_admin, is_owner: u.is_owner,
            },
        };
    }
}
