import pool from "../../config/db.js";

// Columnas expuestas del proveedor (incluye 'activo' para soft-delete)
const COLS = "P.id, P.nombre, P.telefono, P.email, P.domicilio, P.empresa_id, P.activo";

const QUERIES = {
    SELECT_BY_ID: `SELECT ${COLS} FROM proveedores P WHERE P.empresa_id = $1 AND P.id = $2`,
    INSERT: `
        INSERT INTO proveedores (nombre, telefono, email, domicilio, empresa_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, telefono, email, domicilio, empresa_id, activo
    `,
    UPDATE: `
        UPDATE proveedores
        SET nombre = $1,
            telefono = $2,
            email = $3,
            domicilio = $4,
            activo = COALESCE($7, activo)
        WHERE id = $5 AND empresa_id = $6
        RETURNING id, nombre, telefono, email, domicilio, empresa_id, activo
    `,
    // Soft-delete: desactiva en vez de borrar, para conservar el historial (compras/productos)
    SOFT_DELETE: `
        UPDATE proveedores SET activo = false
        WHERE id = $1 AND empresa_id = $2
        RETURNING id, nombre, telefono, email, domicilio, empresa_id, activo
    `,
    // Estado del proveedor dentro de la empresa (para validar referencias)
    ESTADO: `SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2`,
};

export default class ProveedorRepository {
    // Por defecto solo activos; ?incluir_inactivos=true trae todos.
    async findAll(empresa_id, { incluirInactivos = false } = {}) {
        const filtroActivos = incluirInactivos ? "" : " AND P.activo = true";
        const sql = `SELECT ${COLS} FROM proveedores AS P WHERE P.empresa_id = $1${filtroActivos} ORDER BY P.id ASC`;
        const result = await pool.query(sql, [empresa_id]);
        return result.rows;
    }

    async findByID(empresa_id, id) {
        if (!empresa_id) throw new Error("empresa_id es requerido");
        if (!id) throw new Error("ID es requerido");
        const result = await pool.query(QUERIES.SELECT_BY_ID, [empresa_id, id]);
        return result.rows[0];
    }

    // Devuelve { activo } si el proveedor pertenece a la empresa, o null si no existe.
    async estado(empresa_id, id) {
        const result = await pool.query(QUERIES.ESTADO, [id, empresa_id]);
        return result.rows[0] ?? null;
    }

    async create(data, empresa_id) {
        const { nombre, domicilio = null, telefono = null, email = null } = data;
        if (!nombre || !empresa_id) throw new Error("nombre y empresa_id son requeridos");
        const result = await pool.query(QUERIES.INSERT, [nombre, telefono, email, domicilio, empresa_id]);
        return result.rows[0];
    }

    async update(id, data, empresa_id) {
        if (!id) throw new Error("ID es requerido");
        if (!empresa_id) throw new Error("empresa_id es requerido");
        const { nombre, telefono = null, email = null, domicilio = null, activo } = data;
        if (!nombre) throw new Error("nombre es requerido");
        const result = await pool.query(QUERIES.UPDATE, [
            nombre, telefono, email, domicilio, id, empresa_id, activo ?? null,
        ]);
        return result.rows[0];
    }

    // Soft-delete: devuelve el proveedor desactivado (o lanza si no existe).
    async remove(id, empresa_id) {
        if (!empresa_id) throw new Error("empresa_id es requerido");
        if (!id) throw new Error("ID es requerido");
        const result = await pool.query(QUERIES.SOFT_DELETE, [id, empresa_id]);
        if (result.rowCount === 0) throw new Error("Proveedor no encontrado");
        return result.rows[0];
    }
}
