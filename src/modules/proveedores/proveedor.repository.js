import pool from "../../config/db.js";

// Consultas SQL
const QUERIES = {
    SELECT_ALL: `
         SELECT 
            P.id,
            P.nombre,
            P.email,
            P.telefono,
            p.domicilio,
            P.empresa_id
        FROM proveedores AS P
        WHERE P.empresa_id = $1
        ORDER BY P.id ASC;
    `,
    SELECT_BY_ID: `
        SELECT P.id, P.nombre, P.telefono, P.email, P.domicilio, P.empresa_id
        FROM proveedores P
        WHERE P.empresa_id = $1 AND P.id = $2
    `,
    INSERT: `
        INSERT INTO proveedores (nombre, telefono, email, domicilio, empresa_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, telefono, email, empresa_id, domicilio
    `,
    UPDATE: `
        UPDATE proveedores
        SET nombre = $1,
            telefono = $2,
            email = $3,
            domicilio = $4
        WHERE id = $5 AND empresa_id = $6
        RETURNING id, nombre, telefono, email, domicilio, empresa_id
    `,
    DELETE: `DELETE FROM proveedores WHERE id = $1 AND empresa_id = $2 RETURNING id`,
};

export default class ProveedorRepository {
    async findAll(empresa_id) {
        try {
            const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
            return result.rows;
        } catch (error) {
            throw new Error(`Error al obtener proveedores: ${error.message}`);
        }
    }

    async findByID(empresa_id, id) {
        try {
            if (!empresa_id) throw new Error("empresa_id es requerido");
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.SELECT_BY_ID, [empresa_id, id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener proveedor por ID: ${error.message}`);
        }
    }

    async create(data, empresa_id) {
        try {
            const { nombre, domicilio, telefono, email } = data;
            if (!nombre || !domicilio || !telefono || !email || !empresa_id) {
                {
                    throw new Error("Todos los campos son requeridos");
                }
            }
            const result = await pool.query(QUERIES.INSERT, [
                nombre,
                telefono,
                email,
                domicilio,
                empresa_id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al crear proveedor: ${error.message}`);
        }
    }

    async update(id, data, empresa_id) {
        try {
            if (!id) throw new Error("ID es requerido");
            if (!empresa_id) throw new Error("empresa_id es requerido");
            const { nombre, telefono, email, domicilio } = data;
            if (!nombre || !telefono || !email || !domicilio || !empresa_id) {
                throw new Error("Todos los campos son requeridos");
            }
            const result = await pool.query(QUERIES.UPDATE, [
                nombre,
                telefono,
                email,
                domicilio,
                id,
                empresa_id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al actualizar proveedor: ${error.message}`);
        }
    }

    async remove(id, empresa_id) {
        try {
            if (!empresa_id) throw new Error("empresa_id es requerido");
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.DELETE, [id, empresa_id]);
            if (result.rowCount === 0) {
                throw new Error("Proveedor no encontrado");
            }
            return { id: result.rows[0].id };
        } catch (error) {
            throw new Error(`Error al eliminar proveedor: ${error.message}`);
        }
    }
}
