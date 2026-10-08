import pool from "../../config/db.js";

// Rol "owner" sembrado en la migración base (db/migrations/001_baseline.sql).
const ROLE_ID_OWNER = 1;

const QUERIES = {
    LISTAR_EMPRESAS: `
        SELECT e.id, e.nombre, e.activo, e.created_at,
               o.id AS owner_id, o.nombre AS owner_nombre, o.email AS owner_email,
               o.must_change_password AS owner_must_change_password,
               (o.id IS NOT NULL AND o.password_hash IS NULL) AS owner_invitacion_pendiente,
               (SELECT COUNT(*)::int FROM usuarios u2 WHERE u2.empresa_id = e.id) AS usuarios_total
        FROM empresas e
        LEFT JOIN usuarios o ON o.empresa_id = e.id AND o.is_owner = true
        ORDER BY e.id ASC
    `,
    INSERT_EMPRESA: `
        INSERT INTO empresas (nombre, titular, telefono, email, domicilio)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nombre, titular, telefono, email, domicilio, activo, created_at
    `,
    SEED_CATEGORIAS_GASTO: `
        INSERT INTO categorias_gasto (empresa_id, nombre)
        SELECT $1, c.nombre FROM (VALUES
            ('Renta'),('Luz'),('Agua'),('Gas'),('Sueldos'),
            ('Mantenimiento'),('Publicidad'),('Impuestos y comisiones'),('Otros')
        ) AS c(nombre)
        ON CONFLICT (empresa_id, lower(nombre)) DO NOTHING
    `,
    INSERT_OWNER: `
        INSERT INTO usuarios
            (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email, password_hash, must_change_password)
        VALUES ($1, $2, $3, true, true, $4, $5, $6, $7, true)
        RETURNING id, nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, email
    `,
    FIND_OWNER_DETALLE: `
        SELECT u.id, u.nombre, u.email, u.password_hash, e.nombre AS empresa
        FROM usuarios u JOIN empresas e ON e.id = u.empresa_id WHERE u.empresa_id = $1 AND u.is_owner = true LIMIT 1
    `,
    UPDATE_ESTADO: `UPDATE empresas SET activo = $2 WHERE id = $1 RETURNING id, nombre, activo`,
    FIND_OWNER: `SELECT id, empresa_id FROM usuarios WHERE empresa_id = $1 AND is_owner = true LIMIT 1`,
    RESET_OWNER_PASSWORD: `
        UPDATE usuarios SET password_hash = $2, must_change_password = true, token_version = token_version + 1
        WHERE id = $1
        RETURNING id, empresa_id
    `,
};

export default class PlatformRepository {
    async listarEmpresas() {
        const result = await pool.query(QUERIES.LISTAR_EMPRESAS);
        return result.rows;
    }

    // Crea la empresa y su primer Owner en una sola transacción: si el usuario falla
    // (p. ej. email ya usado en otra empresa), la empresa tampoco queda creada.
    async crearEmpresaConOwner(empresaData, ownerData) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const { nombre, titular, telefono, email, domicilio } = empresaData;
            const empresaRes = await client.query(QUERIES.INSERT_EMPRESA, [
                nombre, titular ?? null, telefono ?? null, email ?? null, domicilio ?? null,
            ]);
            const empresa = empresaRes.rows[0];

            await client.query(QUERIES.SEED_CATEGORIAS_GASTO, [empresa.id]);

            const password_hash = ownerData.password_hash;
            const ownerRes = await client.query(QUERIES.INSERT_OWNER, [
                ownerData.nombre, ownerData.codigo_ingreso, ownerData.puesto ?? null,
                ROLE_ID_OWNER, empresa.id, ownerData.email, password_hash,
            ]);
            const owner = ownerRes.rows[0];

            await client.query("COMMIT");
            return { empresa, owner };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async cambiarEstado(id, activo) {
        const result = await pool.query(QUERIES.UPDATE_ESTADO, [id, activo]);
        return result.rows[0];
    }

    async findOwnerDetalle(empresa_id) {
        return (await pool.query(QUERIES.FIND_OWNER_DETALLE, [empresa_id])).rows[0];
    }

    async findOwner(empresa_id) {
        const result = await pool.query(QUERIES.FIND_OWNER, [empresa_id]);
        return result.rows[0];
    }

    // Resetea la contraseña del Owner de una empresa: queda temporal (must_change_password) y
    // revoca sus sesiones vigentes (bump de token_version), igual que cualquier cambio de password.
    async resetearPasswordOwner(owner_id, password_hash) {
        const result = await pool.query(QUERIES.RESET_OWNER_PASSWORD, [owner_id, password_hash]);
        return result.rows[0];
    }
}
