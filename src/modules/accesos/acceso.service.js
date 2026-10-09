import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";

export default class AccesoService {
    constructor(accesoRepository) {
        this.repo = accesoRepository;
    }

    // Maestro: usuarios Owner/Admin con los accesos que ya tienen.
    async listar(filtros) {
        const usuarios = await this.repo.compartibles(filtros);
        const accesos = await this.repo.accesosDe(usuarios.map((u) => u.id));
        return usuarios.map((u) => ({
            ...u,
            accesos: accesos
                .filter((a) => a.usuario_id === u.id)
                .map(({ usuario_id: _u, ...a }) => a),
        }));
    }

    // Maestro: da (o actualiza) el acceso de `usuario_id` a `empresa_id`. Solo a Owner/Admin activos, nunca a la empresa base, nunca a
    // una empresa desactivada. El rol del acceso (is_admin/role_id) vale solo en esa empresa.
    async conceder(actor, usuario_id, empresa_id, { is_admin = true, role_id = null } = {}) {
        const usuario = await this.repo.usuario(usuario_id);
        if (!usuario) throw ApiError.notFound("Usuario no encontrado");
        if (usuario.activo === false || !(usuario.is_owner || usuario.is_admin)) {
            throw ApiError.badRequest(
                "Solo se puede dar acceso a otra empresa a un Owner o Admin activo",
            );
        }
        const empresa = await this.repo.empresa(empresa_id);
        if (!empresa) throw ApiError.notFound("Empresa no encontrada");
        if (empresa.activo === false) throw ApiError.badRequest("La empresa está desactivada");
        if (Number(usuario.empresa_id) === Number(empresa_id)) {
            throw ApiError.badRequest("Esa es la empresa base del usuario: ya tiene acceso");
        }
        if (role_id != null && !(await this.repo.existeRol(role_id))) {
            throw ApiError.badRequest("El rol indicado no existe");
        }
        const acceso = await this.repo.conceder({
            usuario_id,
            empresa_id,
            is_admin,
            role_id,
            otorgado_por: actor.id,
        });
        invalidarUsuarioActivo(usuario_id);
        return acceso;
    }

    // Retira el acceso (lo desactiva, no lo borra: lo que esa persona hizo en la empresa conserva un autor válido).
    async retirar(usuario_id, empresa_id) {
        const acceso = await this.repo.retirar(usuario_id, empresa_id);
        if (!acceso) throw ApiError.notFound("Ese usuario no tiene acceso a esa empresa");
        invalidarUsuarioActivo(usuario_id);
        return acceso;
    }

    // Owner de la empresa destino: retira un acceso a SU empresa (la empresa viene de la URL, ya validada contra el token).
    async retirarComoOwner(actor, empresa_id, usuario_id) {
        if (Number(actor.id) === Number(usuario_id)) {
            throw ApiError.badRequest("No puedes retirarte el acceso a ti mismo");
        }
        return await this.retirar(usuario_id, empresa_id);
    }
}
