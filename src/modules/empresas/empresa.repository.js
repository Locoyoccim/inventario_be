import pool from "../../config/db.js";

const QUERIES = {
    SELECT_ALL: `SELECT * FROM empresas ORDER BY id ASC`,
    SELECT_BY_ID: `SELECT * FROM empresas WHERE id = $1`,
    EXISTS_EMPRESA: `SELECT 1 FROM empresas WHERE id = $1`,
    INSERT: `
        INSERT INTO empresas (nombre, titular, telefono, email, domicilio)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, titular, telefono, email, domicilio
    `,
    UPDATE: `
        UPDATE empresas 
        SET nombre = $1, titular = $2, telefono = $3, email = $4, domicilio = $5 
        WHERE id = $6
        RETURNING id, nombre, titular, telefono, email, domicilio
    `,
    DELETE: `DELETE FROM empresas WHERE id = $1 RETURNING id`,
};

export default class EmpresaRepository {
    async findAll() {
        const result = await pool.query(QUERIES.SELECT_ALL);
        return result.rows;
    }

    async findById(id) {
        const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
        return result.rows[0];
    }

    async existsEmpresa(id) {
        const result = await pool.query(QUERIES.EXISTS_EMPRESA, [id]);
        return result.rowCount > 0;
    }

    async create({ nombre, titular, telefono, email, domicilio }) {
        if (!nombre || !titular || !telefono || !email || !domicilio) {
            throw new Error("Todos los campos son requeridos");
        }

        const values = [nombre, titular, telefono, email, domicilio];
        const result = await pool.query(QUERIES.INSERT, values);
        return result.rows[0];
    }

    async update(id, { nombre, titular, telefono, email, domicilio }) {
        if (!id) throw new Error("ID es requerido");
        if (!nombre || !titular || !telefono || !email || !domicilio) {
            throw new Error("Todos los campos son requeridos");
        }

        const values = [nombre, titular, telefono, email, domicilio, id];
        const result = await pool.query(QUERIES.UPDATE, values);
        return result.rows[0];
    }

    async remove(id) {
        try {
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.DELETE, [id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al eliminar empresa: ${error.message}`);
        }
    }
}
