import pool from "../../config/db.js";

export default class EmpresaRepository {
    async findAll() {
        const result = await pool.query("SELECT * FROM empresas");
        return result.rows;
    }

    async findById(id) {
        const result = await pool.query("SELECT * FROM empresas WHERE id = $1", [id]);
        return result.rows[0];
    }

    async existsEmpresa(id) {
        const result = await pool.query("SELECT 1 FROM empresas WHERE id = $1", [id]);
        return result.rowCount > 0;
    }
}
