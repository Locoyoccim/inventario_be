import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

const QUERIES = {
    SELECT_ALL: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               u.email, u.activo, u.role_id, r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.empresa_id = $1
        ORDER BY u.id ASC
    `,
    SELECT_BY_ID: `
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
               u.email, u.activo, u.role_id, r.nombre AS rol
        FROM usuarios u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.empresa_id = $1 AND u.id = $2
    `,
    SELECT_PROFILE: `
        SELECT u.id, u.nombre, u.email, u.is_admin, u.is_owner, u.is_platform_admin, u.must_change_password,
               u.empresa_id, u.activo, u.role_id, r.permisos
        FROM usuarios u
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.empresa_id = $1 AND u.id = $2
    `,
    SELECT_COUNT: `SELECT COUNT(*)::int AS total FROM usuarios`,
    SELECT_BY_EMAIL: `
        SELECT u.id, u.nombre, u.email, u.password_hash, u.is_admin, u.is_owner, u.is_platform_admin,
               u.must_change_password, u.role_id, u.empresa_id, u.activo, u.token_version,
               e.activo AS empresa_activa, r.permisos
        FROM usuarios u
        JOIN empresas e ON e.id = u.empresa_id
        LEFT JOIN roles r ON r.id = u.role_id
        WHERE lower(trim(u.email)) = lower(trim($1))
        ORDER BY u.id
        LIMIT 1
    `,
    SELECT_PASSWORD_HASH: `SELECT password_hash FROM usuarios WHERE id = $1 AND empresa_id = $2`,
    UPDATE_OWN_PASSWORD: `
        UPDATE usuarios
        SET password_hash = $1, must_change_password = false
        WHERE id = $2 AND empresa_id = $3
        RETURNING id
    `,
    INSERT: `
        INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, activo
    `,
    // Campos opcionales con COALESCE: lo que no se envia conserva su valor.
    UPDATE: `
        WITH updated AS (
            UPDATE usuarios
            SET nombre = $1, codigo_ingreso = $2,
                puesto = COALESCE($3, puesto),
                is_admin = COALESCE($4, is_admin),
                role_id = COALESCE($5, role_id),
                email = COALESCE($8, email),
                activo = COALESCE($9, activo),
                password_hash = COALESCE($10, password_hash)
            WHERE id = $7 AND empresa_id = $6
            RETURNING *
        )
        SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner,
               u.role_id, u.empresa_id, u.email, u.activo, r.nombre AS rol
        FROM updated u
        LEFT JOIN roles r ON u.role_id = r.id
    `,
    DELETE: `DELETE FROM usuarios WHERE empresa_id = $1 AND id = $2 RETURNING id`,
    BUMP_TOKEN: `UPDATE usuarios SET token_version = token_version + 1 WHERE id = $1 AND empresa_id = $2 RETURNING token_version`,
};

export default class UsuarioRepository {
    async findAll(empresa_id) {
        const result = await pool.query(QUERIES.SELECT_ALL, [empresa_id]);
        return result.rows;
    }

    async findById(empresa_id, id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        const result = await pool.query(QUERIES.SELECT_BY_ID, [empresa_id, id]);
        return result.rows[0];
    }

    async create(empresa_id, userData) {
        const {
            nombre, codigo_ingreso, puesto,
            is_admin = false, is_owner = false, role_id,
            email = null, password_hash = null,
        } = userData;

        // El acceso lo define is_admin (Admin/Operativo); puesto y role_id son opcionales.
        if (!nombre || !codigo_ingreso || !empresa_id) {
            throw ApiError.badRequest("Faltan campos requeridos (nombre, codigo_ingreso)");
        }

        const result = await pool.query(QUERIES.INSERT, [
            nombre, codigo_ingreso, puesto ?? null, is_admin, is_owner, role_id ?? null, empresa_id, email, password_hash,
        ]);
        return result.rows[0];
    }

    async update(empresa_id, id, userData) {
        if (!empresa_id) throw ApiError.badRequest("empresa_id es requerido");
        if (!id) throw ApiError.badRequest("ID es requerido");
        const { nombre, codigo_ingreso, puesto, is_admin, role_id, email, activo, password_hash } = userData;
        // is_owner no se cambia por API (el dueno se define en el setup).
        const result = await pool.query(QUERIES.UPDATE, [
            nombre, codigo_ingreso, puesto ?? null, is_admin ?? null, role_id ?? null, empresa_id, id,
            email ?? null, activo ?? null, password_hash ?? null,
        ]);
        return result.rows[0];
    }

    async remove(empresa_id, id) {
        if (!id) throw ApiError.badRequest("ID es requerido");
        const result = await pool.query(QUERIES.DELETE, [empresa_id, id]);
        return result.rows[0];
    }

    async findProfile(empresa_id, id) {
        const result = await pool.query(QUERIES.SELECT_PROFILE, [empresa_id, id]);
        return result.rows[0];
    }

    // Sube la versión de token del usuario: invalida todas sus sesiones (JWT) vigentes.
    async bumpTokenVersion(empresa_id, id) {
        const result = await pool.query(QUERIES.BUMP_TOKEN, [id, empresa_id]);
        return result.rows[0];
    }

    async findByEmail(email) {
        const result = await pool.query(QUERIES.SELECT_BY_EMAIL, [email]);
        return result.rows[0];
    }

    async findPasswordHash(empresa_id, id) {
        const result = await pool.query(QUERIES.SELECT_PASSWORD_HASH, [id, empresa_id]);
        return result.rows[0]?.password_hash ?? null;
    }

    // Cambio de la propia contraseña (self-service): no toca otros campos, limpia
    // must_change_password. Distinto del PUT de usuarios (que edita otros usuarios).
    async updateOwnPassword(empresa_id, id, password_hash) {
        const result = await pool.query(QUERIES.UPDATE_OWN_PASSWORD, [password_hash, id, empresa_id]);
        return result.rows[0];
    }

    async countAll() {
        const result = await pool.query(QUERIES.SELECT_COUNT);
        return result.rows[0].total;
    }
}
