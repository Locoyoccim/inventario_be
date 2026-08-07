export default class UsuarioService {
    constructor(usuarioRepository, empresaRepository) {
        this.usuarioRepository = usuarioRepository;
        this.empresaRepository = empresaRepository;
    }

    async getAllUsuarios(empresa_id) {
        return await this.usuarioRepository.findAll(empresa_id);
    }

    async getUsuarioById(empresa_id, id) {
        return await this.usuarioRepository.findById(empresa_id, id);
    }

    async deleteUsuarios(empresa_id, id) {
        return await this.usuarioRepository.remove(empresa_id, id);
    }

    async createUsuario(empresa_id, data) {
        return await this.usuarioRepository.create(empresa_id, data);
    }

    async updateUsuario(empresa_id, id, data) {
        return await this.usuarioRepository.update(empresa_id, id, data);
    }

    // Validación para revisar si la empresa existe para el usuario que sea crea
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
