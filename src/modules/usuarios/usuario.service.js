export default class UsuarioService {
    constructor(usuarioRepository) {
        this.usuarioRepository = usuarioRepository;
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
}
