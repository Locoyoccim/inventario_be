import pool from "../../config/db.js";

// Consultas SQL
const QUERIES = {
    SELECT_ALL: `
         SELECT 
            P.nombre,
            P.id,
            P.email,
            P.telefono,
            E.nombre AS empresa,
            P.empresa_id
        FROM proveedores AS P
        LEFT JOIN empresas AS E 
            ON P.empresa_id = E.id
        WHERE P.empresa_id = $1
        ORDER BY P.id ASC;
    `,
    SELECT_BY_ID: `
        SELECT P.id, P.nombre, P.telefono, P.email, P.empresa_id,
               E.nombre AS empresa
        FROM proveedores P
        JOIN empresas E ON P.empresa_id = E.id
        WHERE P.id = $1
    `,
    INSERT: `
        INSERT INTO proveedores (nombre, telefono, email, domicilio, empresa_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, telefono, email, empresa_id
    `,
    UPDATE: `
        UPDATE proveedores
        SET nombre = $1,
            telefono = $2,
            email = $3,
            empresa_id = $4
        WHERE id = $5
        RETURNING id, nombre, telefono, email, empresa_id
    `,
    DELETE: `DELETE FROM proveedores WHERE id = ? RETURNING id`,
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

    async findByID(id) {
        try {
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.SELECT_BY_ID, [id]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al obtener proveedor por ID: ${error.message}`);
        }
    }

    async create(data) {
        try {
            const { nombre, domicilio, telefono, email, empresa_id } = data;
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

    async update(id, data) {
        try {
            if (!id) throw new Error("ID es requerido");
            const { nombre, contacto, telefono, email, empresa_id } = data;
            if (!nombre || !contacto || !telefono || !email || !empresa_id) {
                throw new Error("Todos los campos son requeridos");
            }
            const result = await pool.query(QUERIES.UPDATE, [
                nombre,
                contacto,
                telefono,
                email,
                empresa_id,
                id,
            ]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Error al actualizar proveedor: ${error.message}`);
        }
    }

    async remove(id) {
        try {
            if (!id) throw new Error("ID es requerido");
            const result = await pool.query(QUERIES.DELETE, [id]);
            if (result.rowCount === 0) {
                throw new Error("Proveedor no encontrado");
            }
            return { id: result.rows[0].id };
        } catch (error) {
            throw new Error(`Error al eliminar proveedor: ${error.message}`);
        }
    }
}
