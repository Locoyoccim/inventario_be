import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

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
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        if (!id) throw ApiError.badRequest("ID es requerido");
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
        if (!nombre || !empresa_id) throw ApiError.badRequest("nombre y empresa_id son requeridos");
        const result = await pool.query(QUERIES.INSERT, [nombre, telefono, email, domicilio, empresa_id]);
        return result.rows[0];
    }

    async update(id, data, empresa_id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        const { nombre, telefono = null, email = null, domicilio = null, activo } = data;
        if (!nombre) throw ApiError.badRequest("nombre es requerido");
        const result = await pool.query(QUERIES.UPDATE, [
            nombre, telefono, email, domicilio, id, empresa_id, activo ?? null,
        ]);
        return result.rows[0];
    }

    // Soft-delete: devuelve el proveedor desactivado (o lanza si no existe).
    async remove(id, empresa_id) {
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        if (!id) throw ApiError.badRequest("ID es requerido");
        const result = await pool.query(QUERIES.SOFT_DELETE, [id, empresa_id]);
        if (result.rowCount === 0) throw ApiError.notFound("Proveedor no encontrado");
        return result.rows[0];
    }

    // Cuenta referencias del proveedor (para decidir si se puede borrar en definitivo).
    async contarReferencias(empresa_id, id) {
        const r = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM productos WHERE proveedor_id = $1 AND empresa_id = $2)::int AS productos,
                (SELECT COUNT(*) FROM compra WHERE proveedor_id = $1 AND empresa_id = $2)::int AS compras,
                (SELECT COUNT(*) FROM gastos WHERE proveedor_id = $1 AND empresa_id = $2)::int AS gastos`,
            [id, empresa_id]
        );
        return r.rows[0];
    }

    // Borrado real: solo si no tiene historial (productos/compras/gastos); si tiene, 409 con conteos.
    async eliminarDefinitivo(empresa_id, id) {
        if (!(await this.estado(empresa_id, id))) throw ApiError.notFound("Proveedor no encontrado");
        const refs = await this.contarReferencias(empresa_id, id);
        if (refs.productos + refs.compras + refs.gastos > 0) {
            throw new ApiError(409, "El proveedor tiene historial y no puede borrarse; desactívalo o fusiónalo", refs);
        }
        await pool.query("DELETE FROM proveedores WHERE id = $1 AND empresa_id = $2", [id, empresa_id]);
        return { id: Number(id), eliminado: true };
    }

    // Fusiona el proveedor origen en 'destino_id': reasigna productos/compras/gastos y desactiva el origen.
    async fusionar(empresa_id, id, destino_id) {
        if (Number(id) === Number(destino_id)) throw ApiError.badRequest("El destino no puede ser el mismo proveedor");
        if (!(await this.estado(empresa_id, id))) throw ApiError.notFound("Proveedor origen no encontrado");
        const dst = await this.estado(empresa_id, destino_id);
        if (!dst) throw ApiError.badRequest("El proveedor destino no existe en la empresa");
        if (dst.activo === false) throw ApiError.badRequest("El proveedor destino está inactivo");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("UPDATE productos SET proveedor_id = $1 WHERE proveedor_id = $2 AND empresa_id = $3", [destino_id, id, empresa_id]);
            await client.query("UPDATE compra SET proveedor_id = $1 WHERE proveedor_id = $2 AND empresa_id = $3", [destino_id, id, empresa_id]);
            await client.query("UPDATE gastos SET proveedor_id = $1 WHERE proveedor_id = $2 AND empresa_id = $3", [destino_id, id, empresa_id]);
            await client.query("UPDATE proveedores SET activo = false WHERE id = $1 AND empresa_id = $2", [id, empresa_id]);
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
        return { fusionado: Number(id), destino: Number(destino_id) };
    }

    // Historial del proveedor: últimas compras, totales 30/90 días y último precio por producto.
    async resumenProveedor(empresa_id, id) {
        if (!(await this.estado(empresa_id, id))) throw ApiError.notFound("Proveedor no encontrado");
        const ultimas = (await pool.query(
            `SELECT id, fecha, referencia, total FROM compra
             WHERE empresa_id = $1 AND proveedor_id = $2 AND anulado = false
             ORDER BY fecha DESC, id DESC LIMIT 10`, [empresa_id, id])).rows;
        const tot = (await pool.query(
            `SELECT
                COALESCE(SUM(total) FILTER (WHERE fecha >= CURRENT_DATE - INTERVAL '30 days'), 0) AS d30,
                COALESCE(SUM(total) FILTER (WHERE fecha >= CURRENT_DATE - INTERVAL '90 days'), 0) AS d90
             FROM compra WHERE empresa_id = $1 AND proveedor_id = $2 AND anulado = false`, [empresa_id, id])).rows[0];
        const precios = (await pool.query(
            `SELECT DISTINCT ON (m.producto_id) m.producto_id, p.producto, m.costo_unitario, m.fecha
             FROM movimientosinventario m
             JOIN compra c ON c.id = m.referencia_id AND m.referencia_tipo = 'COMPRA'
             JOIN productos p ON p.id = m.producto_id
             WHERE c.empresa_id = $1 AND c.proveedor_id = $2 AND c.anulado = false
             ORDER BY m.producto_id, m.fecha DESC, m.id DESC`, [empresa_id, id])).rows;
        return { ultimas_compras: ultimas, total_30_dias: tot.d30, total_90_dias: tot.d90, ultimo_precio_por_producto: precios };
    }
}
