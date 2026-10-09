import pool from "../../config/db.js";

// Accesos de un usuario a empresas distintas de la suya (tabla usuario_empresas). Dos puertas, ambas acotadas:
//   · el maestro de plataforma concede/retira por (usuario, empresa) — ámbito global de plataforma;
//   · el Owner de una empresa solo puede retirar el acceso A SU empresa (la empresa sale de la URL, validada por empresaGuard).
const QUERIES = {
    SELECT_USUARIO: `
        SELECT id, nombre, email, empresa_id, activo, is_admin, is_owner
        FROM usuarios WHERE id = $1`,
    SELECT_EMPRESA: `SELECT id, nombre, activo FROM empresas WHERE id = $1`,
    SELECT_ROL: `SELECT id FROM roles WHERE id = $1`,
    UPSERT: `
        INSERT INTO usuario_empresas (usuario_id, empresa_id, is_admin, role_id, activo, otorgado_por)
        VALUES ($1, $2, $3, $4, true, $5)
        ON CONFLICT (usuario_id, empresa_id)
        DO UPDATE SET is_admin = EXCLUDED.is_admin, role_id = EXCLUDED.role_id, activo = true,
                      otorgado_por = EXCLUDED.otorgado_por, updated_at = now()
        RETURNING usuario_id, empresa_id, is_admin, role_id, activo`,
    RETIRAR: `
        UPDATE usuario_empresas SET activo = false, updated_at = now()
        WHERE usuario_id = $1 AND empresa_id = $2 AND activo
        RETURNING usuario_id, empresa_id, is_admin, role_id, activo`,
    // Usuarios que SÍ pueden recibir acceso (Owner/Admin activos), con su empresa base. El WHERE opcional se arma abajo.
    SELECT_COMPARTIBLES: `
        SELECT u.id, u.nombre, u.email, u.empresa_id, eb.nombre AS empresa, u.is_owner, u.is_admin
        FROM usuarios u
        JOIN empresas eb ON eb.id = u.empresa_id
        WHERE u.activo AND (u.is_owner OR u.is_admin)`,
    SELECT_ACCESOS_DE: `
        SELECT ue.usuario_id, ue.empresa_id, e.nombre AS empresa, ue.is_admin, ue.role_id, r.nombre AS rol, ue.activo
        FROM usuario_empresas ue
        JOIN empresas e ON e.id = ue.empresa_id
        LEFT JOIN roles r ON r.id = ue.role_id
        WHERE ue.usuario_id = ANY($1::int[])
        ORDER BY e.nombre`,
    // Empresas a las que la persona puede cambiar además de la suya (acceso vigente y empresa activa), para el selector del panel.
    SELECT_OPCIONES: `
        SELECT e.id, e.nombre
        FROM usuario_empresas ue
        JOIN empresas e ON e.id = ue.empresa_id
        WHERE ue.usuario_id = $1 AND ue.activo AND e.activo
        ORDER BY e.nombre`,
    // Personas de OTRA empresa con acceso a ésta (para la lista de Usuarios, solo lectura). No se expone su empresa base.
    SELECT_COMPARTIDOS: `
        SELECT u.id, u.nombre, u.puesto, u.email, u.activo, ue.is_admin, ue.role_id, r.nombre AS rol,
               ue.empresa_id, TRUE AS compartido
        FROM usuario_empresas ue
        JOIN usuarios u ON u.id = ue.usuario_id
        LEFT JOIN roles r ON r.id = ue.role_id
        WHERE ue.empresa_id = $1 AND ue.activo
        ORDER BY u.nombre`,
};

export default class AccesoRepository {
    async usuario(id) {
        return (await pool.query(QUERIES.SELECT_USUARIO, [id])).rows[0];
    }
    async empresa(id) {
        return (await pool.query(QUERIES.SELECT_EMPRESA, [id])).rows[0];
    }
    async existeRol(id) {
        return (await pool.query(QUERIES.SELECT_ROL, [id])).rowCount > 0;
    }
    async conceder({ usuario_id, empresa_id, is_admin, role_id, otorgado_por }) {
        const r = await pool.query(QUERIES.UPSERT, [
            usuario_id,
            empresa_id,
            is_admin,
            role_id,
            otorgado_por,
        ]);
        return r.rows[0];
    }
    async retirar(usuario_id, empresa_id) {
        return (await pool.query(QUERIES.RETIRAR, [usuario_id, empresa_id])).rows[0];
    }
    async compartibles({ empresa_id = null, q = null } = {}) {
        const params = [];
        let sql = QUERIES.SELECT_COMPARTIBLES;
        if (empresa_id) {
            params.push(empresa_id);
            sql += ` AND u.empresa_id = $${params.length}`;
        }
        if (q) {
            params.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`);
            sql += ` AND (u.nombre ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
        }
        sql += " ORDER BY eb.nombre, u.nombre LIMIT 200";
        return (await pool.query(sql, params)).rows;
    }
    async accesosDe(usuarioIds) {
        if (!usuarioIds.length) return [];
        return (await pool.query(QUERIES.SELECT_ACCESOS_DE, [usuarioIds])).rows;
    }
    async opcionesDe(usuario_id) {
        return (await pool.query(QUERIES.SELECT_OPCIONES, [usuario_id])).rows;
    }
    async compartidosEn(empresa_id) {
        return (await pool.query(QUERIES.SELECT_COMPARTIDOS, [empresa_id])).rows;
    }
}
