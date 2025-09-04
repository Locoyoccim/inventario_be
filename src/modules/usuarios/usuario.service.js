export default class UsuarioService {
    constructor(usuarioRepository, empresaRepository) {
        this.usuarioRepository = usuarioRepository;
        this.empresaRepository = empresaRepository; 
    }

    async getAllUsuarios() {
        return await this.usuarioRepository.findAll();
    }

    async getUsuarioById(id) {
        return await this.usuarioRepository.findById(id);
    }

    async deleteUsuarios(id) {
        return await this.usuarioRepository.remove(id);
    }

    async createUsuario(data) {
        return await this.usuarioRepository.create(data);
    }

    async updateUsuario(id, data) {
        return await this.usuarioRepository.update(id, data);
    }

    // Validación para revisar si la empresa existe para el usuario que sea crea
    async existsEmpresa(empresa_id) {
        return await this.empresaRepository.existsEmpresa(empresa_id);
    }
}
