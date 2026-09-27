import bcrypt from "bcryptjs";
import ApiError from "../../utils/ApiError.js";
import { invalidarUsuarioActivo } from "../../middlewares/activeUser.js";

export default class PlatformService {
    constructor(platformRepository) {
        this.platformRepository = platformRepository;
    }

    async listarEmpresas() {
        return await this.platformRepository.listarEmpresas();
    }

    async crearEmpresa({ empresa, owner }) {
        const password_hash = await bcrypt.hash(owner.password, 10);
        return await this.platformRepository.crearEmpresaConOwner(empresa, { ...owner, password_hash });
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
        const actualizado = await this.platformRepository.resetearPasswordOwner(owner.id, password_hash);
        invalidarUsuarioActivo(owner.id);
        return actualizado;
    }
}
