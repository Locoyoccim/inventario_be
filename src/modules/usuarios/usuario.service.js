import bcrypt from "bcryptjs";
import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";

export default class UsuarioService {
    constructor(usuarioRepository, empresaRepository) {
        this.usuarioRepository = usuarioRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllUsuarios(empresa_id) {
        return await this.usuarioRepository.findAll(empresa_id);
    }

    async createUsuario(empresa_id, data) {
        let payload = { ...data, is_owner: false };
        if (data.password) {
            const password_hash = await bcrypt.hash(data.password, 10);
            payload = { ...payload, password_hash };
        }
        return await this.usuarioRepository.create(empresa_id, payload);
    }

    // actor = usuario que hace la peticion (req.user). Reglas:
    //  - nadie se desactiva ni se quita el rol Admin a si mismo (evita quedarse fuera);
    //  - al dueno (is_owner) no se le desactiva ni se le quita Admin.
    async updateUsuario(empresa_id, id, data, actor = null) {
        const actual = await this.usuarioRepository.findById(empresa_id, id);
        if (!actual) return null;
        const pierdeAcceso = data.activo === false || data.is_admin === false;
        if (pierdeAcceso && actor && Number(actor.id) === Number(id)) {
            throw ApiError.badRequest("No puedes desactivarte ni quitarte el rol Admin a ti mismo");
        }
        if (pierdeAcceso && actual.is_owner) {
            throw ApiError.badRequest(
                "El dueño de la empresa no se puede desactivar ni perder el rol Admin",
            );
        }
        if (
            actual.is_owner &&
            !(actor && Number(actor.id) === Number(id)) &&
            (data.email !== undefined || data.password !== undefined)
        ) {
            throw ApiError.badRequest("Solo el dueño puede modificar su propia cuenta");
        }
        const payload = { ...data };
        delete payload.password;
        delete payload.forzar_cierre_sesion;
        if (data.password) payload.password_hash = await bcrypt.hash(data.password, 10);
        const actualizado = await this.usuarioRepository.update(empresa_id, id, payload);
        // Admin fuerza el cierre de sesión del usuario objetivo (revoca sus JWT vigentes),
        // y un cambio de password también invalida las sesiones previas.
        if (data.forzar_cierre_sesion || data.password) {
            await this.usuarioRepository.bumpTokenVersion(empresa_id, id);
        }
        invalidarUsuarioActivo(id);
        return actualizado;
    }

    // Validación para revisar si la empresa existe para el usuario que sea crea
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
