export default class RolService {
    constructor(rolRepository) { this.rolRepository = rolRepository; }
    async getAll() { return await this.rolRepository.findAll(); }
}
