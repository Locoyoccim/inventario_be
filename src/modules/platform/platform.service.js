import bcrypt from "bcryptjs";
import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";
import { invitarUsuario } from "../auth/invitacion.service.js";

export default class PlatformService {
    constructor(platformRepository) {
        this.platformRepository = platformRepository;
    }

    async listarEmpresas() {
        return await this.platformRepository.listarEmpresas();
    }

    // Sin `owner.password` el owner nace sin contraseña (no puede entrar) y recibe un enlace de un solo uso por
    // correo para definirla: quien da de alta la empresa nunca conoce ni transmite una contraseña.
    async crearEmpresa({ empresa, owner }, actividad = undefined) {
        const invitar = !owner.password;
        const password_hash = invitar ? null : await bcrypt.hash(owner.password, 10);
        const creado = await this.platformRepository.crearEmpresaConOwner(
            empresa,
            { ...owner, password_hash },
            actividad,
        );
        if (!invitar) return creado;
        const invitacion = await invitarUsuario({
            usuario_id: creado.owner.id,
            nombre: creado.owner.nombre,
            email: creado.owner.email,
            empresa: creado.empresa.nombre,
        });
        return { ...creado, invitacion };
    }

    async reenviarInvitacion(empresa_id) {
        const owner = await this.platformRepository.findOwnerDetalle(empresa_id);
        if (!owner) throw ApiError.notFound("La empresa no tiene un Owner asignado");
        if (owner.password_hash)
            throw ApiError.conflict(
                "El owner ya definió su contraseña. Si la olvidó, restablécela desde Empresas.",
            );
        return await invitarUsuario({
            usuario_id: owner.id,
            nombre: owner.nombre,
            email: owner.email,
            empresa: owner.empresa,
        });
    }

    async cambiarEstado(id, activo) {
        const empresa = await this.platformRepository.cambiarEstado(id, activo);
        if (!empresa) throw ApiError.notFound("Empresa no encontrada");
        return empresa;
    }

    async resetearPasswordOwner(empresa_id, passwordNueva) {
        const owner = await this.platformRepository.findOwner(empresa_id);
        if (!owner) throw ApiError.notFound("La empresa no tiene un Owner asignado");
        const password_hash = await bcrypt.hash(passwordNueva, 10);
        const actualizado = await this.platformRepository.resetearPasswordOwner(
            owner.id,
            password_hash,
        );
        invalidarUsuarioActivo(owner.id);
        return actualizado;
    }
}
