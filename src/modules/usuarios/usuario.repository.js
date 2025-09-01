import pool from "../../config/db.js";

export default class UsuarioRepository {
  async findAll() {
    const result = await pool.query(`
      SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
             r.nombre AS rol, e.nombre AS empresa
      FROM usuarios u
      JOIN roles r ON u.role_id = r.id
      JOIN empresas e ON u.empresa_id = e.id
    `);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      `
      SELECT u.id, u.nombre, u.codigo_ingreso, u.puesto, u.is_admin, u.is_owner, u.empresa_id,
             r.nombre AS rol, e.nombre AS empresa
      FROM usuarios u
      JOIN roles r ON u.role_id = r.id
      JOIN empresas e ON u.empresa_id = e.id
      WHERE u.id = $1
    `,
      [id]
    );
    return result.rows[0];
  }

  async create({ nombre, codigo_ingreso, puesto, is_admin = false, is_owner = false, role_id, empresa_id }) {
    const result = await pool.query(
      `
      INSERT INTO usuarios (nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
      [nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id]
    );
    return result.rows[0];
  }

  async update(id, { nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id }) {
    const result = await pool.query(
      `
      UPDATE usuarios
      SET nombre = $1,
          codigo_ingreso = $2,
          puesto = $3,
          is_admin = $4,
          is_owner = $5,
          role_id = $6,
          empresa_id = $7
      WHERE id = $8
      RETURNING id
    `,
      [nombre, codigo_ingreso, puesto, is_admin, is_owner, role_id, empresa_id, id]
    );
    return result.rows[0];
  }

  async remove(id) {
    const result = await pool.query(
      `DELETE FROM usuarios WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows[0];
  }
}
