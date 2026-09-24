import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";

// UNION del libro (ingresos + gastos no anulados + compras). $1 = empresa_id.
const LIBRO_UNION = `(
    SELECT 'INGRESO' AS origen, i.id, i.fecha, i.concepto, 'Ingresos' AS categoria,
           i.metodo_pago, i.monto, NULL::text AS proveedor, u.nombre AS usuario
    FROM ingresos i LEFT JOIN usuarios u ON u.id = i.usuario_id
    WHERE i.empresa_id = $1 AND i.anulado = false
    UNION ALL
    SELECT 'GASTO', g.id, g.fecha, g.concepto, cg.nombre,
           g.metodo_pago, g.monto, pr.nombre, u.nombre
    FROM gastos g
    JOIN categorias_gasto cg ON cg.id = g.categoria_id
    LEFT JOIN proveedores pr ON pr.id = g.proveedor_id
    LEFT JOIN usuarios u ON u.id = g.usuario_id
    WHERE g.empresa_id = $1 AND g.anulado = false
    UNION ALL
    SELECT 'COMPRA', c.id, c.fecha, COALESCE('Compra ' || NULLIF(c.referencia, ''), 'Compra'), 'Compras de insumos',
           NULL, c.total, pr.nombre, u.nombre
    FROM compra c
    LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.empresa_id = $1 AND c.anulado = false
) lib`;

const GASTO_VIEW = `
    SELECT g.id, g.empresa_id, g.fecha, g.categoria_id, cg.nombre AS categoria, g.concepto, g.monto,
           g.metodo_pago, g.proveedor_id, pr.nombre AS proveedor, g.nota,
           g.usuario_id, u.nombre AS usuario, g.anulado, g.anulado_at, g.anulado_por, g.motivo_anulacion, g.created_at
    FROM gastos g
    JOIN categorias_gasto cg ON cg.id = g.categoria_id
    LEFT JOIN proveedores pr ON pr.id = g.proveedor_id
    LEFT JOIN usuarios u ON u.id = g.usuario_id`;

const INGRESO_VIEW = `
    SELECT i.id, i.empresa_id, i.fecha, i.metodo_pago, i.monto, i.concepto, i.nota,
           i.usuario_id, u.nombre AS usuario, i.anulado, i.anulado_at, i.anulado_por, i.motivo_anulacion, i.created_at
    FROM ingresos i
    LEFT JOIN usuarios u ON u.id = i.usuario_id`;

export default class FinanzasRepository {
    // ---------- Categorías de gasto ----------
    async listarCategorias(empresa_id, incluirInactivas = false) {
        const filtro = incluirInactivas ? "" : " AND activo = true";
        const r = await pool.query(
            `SELECT id, empresa_id, nombre, activo, created_at FROM categorias_gasto WHERE empresa_id = $1${filtro} ORDER BY nombre ASC`,
            [empresa_id]
        );
        return r.rows;
    }

    async crearCategoria(empresa_id, nombre) {
        const r = await pool.query(
            "INSERT INTO categorias_gasto (empresa_id, nombre) VALUES ($1, $2) RETURNING id, empresa_id, nombre, activo, created_at",
            [empresa_id, nombre]
        );
        return r.rows[0];
    }

    async actualizarCategoria(empresa_id, id, { nombre, activo }) {
        const r = await pool.query(
            `UPDATE categorias_gasto SET nombre = COALESCE($3, nombre), activo = COALESCE($4, activo)
             WHERE id = $1 AND empresa_id = $2
             RETURNING id, empresa_id, nombre, activo, created_at`,
            [id, empresa_id, nombre ?? null, activo ?? null]
        );
        if (r.rowCount === 0) throw ApiError.notFound("Categoría no encontrada");
        return r.rows[0];
    }

    // Valida que la categoría exista, sea de la empresa y esté activa.
    async #validarCategoria(client, empresa_id, categoria_id) {
        const r = await client.query("SELECT activo FROM categorias_gasto WHERE id = $1 AND empresa_id = $2", [categoria_id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.badRequest("La categoría no existe en la empresa");
        if (r.rows[0].activo === false) throw ApiError.badRequest("La categoría está inactiva");
    }

    async #validarProveedor(client, empresa_id, proveedor_id) {
        if (proveedor_id == null) return;
        const r = await client.query("SELECT activo FROM proveedores WHERE id = $1 AND empresa_id = $2", [proveedor_id, empresa_id]);
        if (r.rowCount === 0) throw ApiError.badRequest("El proveedor no existe en la empresa");
        if (r.rows[0].activo === false) throw ApiError.badRequest("El proveedor está inactivo");
    }

    // ---------- Gastos ----------
    async getGastoById(empresa_id, id) {
        const r = await pool.query(`${GASTO_VIEW} WHERE g.id = $1 AND g.empresa_id = $2`, [id, empresa_id]);
        return r.rows[0];
    }

    async listarGastos(empresa_id, { desde, hasta, categoria_id, incluirAnulados, limit, offset }, soloUsuarioId = null) {
        const where = ["g.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (desde) { where.push(`g.fecha >= $${i}`); params.push(desde); i++; }
        if (hasta) { where.push(`g.fecha <= $${i}`); params.push(hasta); i++; }
        if (categoria_id) { where.push(`g.categoria_id = $${i}`); params.push(categoria_id); i++; }
        if (!incluirAnulados) { where.push("g.anulado = false"); }
        if (soloUsuarioId) { where.push(`g.usuario_id = $${i}`); params.push(soloUsuarioId); i++; }
        const w = where.join(" AND ");
        const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM gastos g WHERE ${w}`, params)).rows[0].total;
        const rows = (await pool.query(
            `${GASTO_VIEW.replace("FROM gastos g", `FROM gastos g`)} WHERE ${w} ORDER BY g.fecha DESC, g.id DESC LIMIT $${i} OFFSET $${i + 1}`,
            [...params, limit, offset]
        )).rows;
        return { rows, total };
    }

    async crearGasto(empresa_id, data, usuario_id) {
        const { fecha, categoria_id, concepto, monto, metodo_pago, proveedor_id = null, nota = null } = data;
        const client = await pool.connect();
        try {
            await this.#validarCategoria(client, empresa_id, categoria_id);
            await this.#validarProveedor(client, empresa_id, proveedor_id);
            const r = await client.query(
                `INSERT INTO gastos (empresa_id, fecha, categoria_id, concepto, monto, metodo_pago, proveedor_id, nota, usuario_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                [empresa_id, fecha, categoria_id, concepto, monto, metodo_pago, proveedor_id, nota, usuario_id]
            );
            return await this.getGastoById(empresa_id, r.rows[0].id);
        } finally {
            client.release();
        }
    }

    async actualizarGasto(empresa_id, id, data) {
        const actual = await this.getGastoById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Gasto no encontrado");
        if (actual.anulado) throw ApiError.conflict("El gasto está anulado y no puede editarse");
        const { fecha, categoria_id, concepto, monto, metodo_pago, proveedor_id = null, nota = null } = data;
        const client = await pool.connect();
        try {
            await this.#validarCategoria(client, empresa_id, categoria_id);
            await this.#validarProveedor(client, empresa_id, proveedor_id);
            await client.query(
                `UPDATE gastos SET fecha=$3, categoria_id=$4, concepto=$5, monto=$6, metodo_pago=$7, proveedor_id=$8, nota=$9
                 WHERE id=$1 AND empresa_id=$2`,
                [id, empresa_id, fecha, categoria_id, concepto, monto, metodo_pago, proveedor_id, nota]
            );
            return await this.getGastoById(empresa_id, id);
        } finally {
            client.release();
        }
    }

    async anularGasto(empresa_id, id, usuario_id, motivo) {
        const actual = await this.getGastoById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Gasto no encontrado");
        if (actual.anulado) throw ApiError.conflict("El gasto ya está anulado");
        await pool.query(
            "UPDATE gastos SET anulado=true, anulado_at=now(), anulado_por=$3, motivo_anulacion=$4 WHERE id=$1 AND empresa_id=$2",
            [id, empresa_id, usuario_id, motivo]
        );
        return await this.getGastoById(empresa_id, id);
    }

    // ---------- Ingresos ----------
    async getIngresoById(empresa_id, id) {
        const r = await pool.query(`${INGRESO_VIEW} WHERE i.id = $1 AND i.empresa_id = $2`, [id, empresa_id]);
        return r.rows[0];
    }

    async listarIngresos(empresa_id, { desde, hasta, metodo_pago, incluirAnulados, limit, offset }, soloUsuarioId = null) {
        const where = ["i.empresa_id = $1"];
        const params = [empresa_id];
        let i = 2;
        if (desde) { where.push(`i.fecha >= $${i}`); params.push(desde); i++; }
        if (hasta) { where.push(`i.fecha <= $${i}`); params.push(hasta); i++; }
        if (metodo_pago) { where.push(`i.metodo_pago = $${i}`); params.push(metodo_pago); i++; }
        if (!incluirAnulados) { where.push("i.anulado = false"); }
        if (soloUsuarioId) { where.push(`i.usuario_id = $${i}`); params.push(soloUsuarioId); i++; }
        const w = where.join(" AND ");
        const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM ingresos i WHERE ${w}`, params)).rows[0].total;
        const rows = (await pool.query(
            `${INGRESO_VIEW} WHERE ${w} ORDER BY i.fecha DESC, i.id DESC LIMIT $${i} OFFSET $${i + 1}`,
            [...params, limit, offset]
        )).rows;
        return { rows, total };
    }

    async crearIngreso(empresa_id, data, usuario_id) {
        const { fecha, metodo_pago, monto, concepto = null, nota = null } = data;
        const r = await pool.query(
            `INSERT INTO ingresos (empresa_id, fecha, metodo_pago, monto, concepto, nota, usuario_id)
             VALUES ($1,$2,$3,$4,COALESCE($5,'Venta del día'),$6,$7) RETURNING id`,
            [empresa_id, fecha, metodo_pago, monto, concepto, nota, usuario_id]
        );
        return await this.getIngresoById(empresa_id, r.rows[0].id);
    }

    async crearIngresosLote(empresa_id, fecha, lineas, usuario_id) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const ids = [];
            for (const l of lineas) {
                const r = await client.query(
                    `INSERT INTO ingresos (empresa_id, fecha, metodo_pago, monto, usuario_id)
                     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                    [empresa_id, fecha, l.metodo_pago, l.monto, usuario_id]
                );
                ids.push(r.rows[0].id);
            }
            await client.query("COMMIT");
            const out = [];
            for (const id of ids) out.push(await this.getIngresoById(empresa_id, id));
            return out;
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    async actualizarIngreso(empresa_id, id, data) {
        const actual = await this.getIngresoById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Ingreso no encontrado");
        if (actual.anulado) throw ApiError.conflict("El ingreso está anulado y no puede editarse");
        const { fecha, metodo_pago, monto, concepto = null, nota = null } = data;
        await pool.query(
            `UPDATE ingresos SET fecha=$3, metodo_pago=$4, monto=$5, concepto=COALESCE($6,'Venta del día'), nota=$7
             WHERE id=$1 AND empresa_id=$2`,
            [id, empresa_id, fecha, metodo_pago, monto, concepto, nota]
        );
        return await this.getIngresoById(empresa_id, id);
    }

    async anularIngreso(empresa_id, id, usuario_id, motivo) {
        const actual = await this.getIngresoById(empresa_id, id);
        if (!actual) throw ApiError.notFound("Ingreso no encontrado");
        if (actual.anulado) throw ApiError.conflict("El ingreso ya está anulado");
        await pool.query(
            "UPDATE ingresos SET anulado=true, anulado_at=now(), anulado_por=$3, motivo_anulacion=$4 WHERE id=$1 AND empresa_id=$2",
            [id, empresa_id, usuario_id, motivo]
        );
        return await this.getIngresoById(empresa_id, id);
    }

    // ---------- Libro (vista unificada) ----------
    async listarMovimientos(empresa_id, { desde, hasta, origen, limit, offset }) {
        const params = [empresa_id, desde ?? null, hasta ?? null, origen ?? null];
        const filtro = `WHERE ($2::date IS NULL OR fecha >= $2::date)
                          AND ($3::date IS NULL OR fecha <= $3::date)
                          AND ($4::text IS NULL OR origen = $4)`;
        const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM ${LIBRO_UNION} ${filtro}`, params)).rows[0].total;
        const rows = (await pool.query(
            `SELECT * FROM ${LIBRO_UNION} ${filtro} ORDER BY fecha DESC, id DESC LIMIT $5 OFFSET $6`,
            [...params, limit, offset]
        )).rows;
        return { rows, total };
    }

    // ---------- Resumen (datos crudos; el cálculo vive en finanzas.logic) ----------
    async resumenRaw(empresa_id, { desde, hasta, unit }) {
        const rango = [empresa_id, desde, hasta];
        const rangoUnit = [empresa_id, desde, hasta, unit];
        const [ingMetodo, gastCat, comprasT, costos, esperado, sinIngreso, comparables, sIng, sCom, sGas, sCosto] = await Promise.all([
            pool.query("SELECT metodo_pago, SUM(monto)::numeric AS total FROM ingresos WHERE empresa_id=$1 AND fecha BETWEEN $2 AND $3 AND anulado=false GROUP BY metodo_pago ORDER BY metodo_pago", rango),
            pool.query("SELECT g.categoria_id, cg.nombre AS categoria, SUM(g.monto)::numeric AS total FROM gastos g JOIN categorias_gasto cg ON cg.id=g.categoria_id WHERE g.empresa_id=$1 AND g.fecha BETWEEN $2 AND $3 AND g.anulado=false GROUP BY g.categoria_id, cg.nombre ORDER BY cg.nombre", rango),
            pool.query("SELECT COALESCE(SUM(total),0)::numeric AS total FROM compra WHERE empresa_id=$1 AND fecha BETWEEN $2 AND $3 AND anulado=false", rango),
            pool.query(`SELECT
                    COALESCE(SUM(CASE WHEN m.tipo_movimiento='VENTA' THEN m.cantidad*m.costo_unitario END),0) AS venta_costo,
                    COALESCE(SUM(CASE WHEN m.tipo_movimiento='DEVOLUCION' AND m.referencia_tipo='VENTA_DIARIA' THEN m.cantidad*m.costo_unitario END),0) AS devol_costo,
                    COALESCE(SUM(CASE WHEN m.tipo_movimiento='MERMA' THEN m.cantidad*m.costo_unitario END),0) AS merma_costo
                FROM movimientosinventario m JOIN productos p ON p.id=m.producto_id
                WHERE p.empresa_id=$1 AND m.fecha::date BETWEEN $2 AND $3`, rango),
            pool.query(`SELECT COUNT(d.id) AS filas,
                    COALESCE(SUM(d.cantidad*d.precio_unitario) FILTER (WHERE d.precio_unitario IS NOT NULL),0) AS esperado
                FROM venta_diaria vd JOIN venta_diaria_detalle d ON d.venta_diaria_id=vd.id
                WHERE vd.empresa_id=$1 AND vd.fecha BETWEEN $2 AND $3`, rango),
            pool.query(`SELECT vd.fecha FROM venta_diaria vd
                WHERE vd.empresa_id=$1 AND vd.fecha BETWEEN $2 AND $3
                  AND NOT EXISTS (SELECT 1 FROM ingresos i WHERE i.empresa_id=$1 AND i.fecha=vd.fecha AND i.anulado=false)
                ORDER BY vd.fecha`, rango),
            pool.query(`SELECT COALESCE(SUM(i.monto),0) AS total FROM ingresos i
                WHERE i.empresa_id=$1 AND i.anulado=false AND i.fecha BETWEEN $2 AND $3
                  AND EXISTS (SELECT 1 FROM venta_diaria vd JOIN venta_diaria_detalle d ON d.venta_diaria_id=vd.id
                              WHERE vd.empresa_id=$1 AND vd.fecha=i.fecha)`, rango),
            pool.query("SELECT to_char(date_trunc($4, fecha),'YYYY-MM-DD') AS periodo, SUM(monto)::numeric AS total FROM ingresos WHERE empresa_id=$1 AND fecha BETWEEN $2 AND $3 AND anulado=false GROUP BY 1", rangoUnit),
            pool.query("SELECT to_char(date_trunc($4, fecha),'YYYY-MM-DD') AS periodo, SUM(total)::numeric AS total FROM compra WHERE empresa_id=$1 AND fecha BETWEEN $2 AND $3 AND anulado=false GROUP BY 1", rangoUnit),
            pool.query("SELECT to_char(date_trunc($4, fecha),'YYYY-MM-DD') AS periodo, SUM(monto)::numeric AS total FROM gastos WHERE empresa_id=$1 AND fecha BETWEEN $2 AND $3 AND anulado=false GROUP BY 1", rangoUnit),
            pool.query(`SELECT to_char(date_trunc($4, m.fecha),'YYYY-MM-DD') AS periodo,
                    COALESCE(SUM(CASE WHEN m.tipo_movimiento='VENTA' THEN m.cantidad*m.costo_unitario
                                      WHEN m.tipo_movimiento='DEVOLUCION' AND m.referencia_tipo='VENTA_DIARIA' THEN -m.cantidad*m.costo_unitario END),0) AS total
                FROM movimientosinventario m JOIN productos p ON p.id=m.producto_id
                WHERE p.empresa_id=$1 AND m.fecha::date BETWEEN $2 AND $3 GROUP BY 1`, rangoUnit),
        ]);

        const c = costos.rows[0];
        const esp = esperado.rows[0];
        return {
            ingresosPorMetodo: ingMetodo.rows,
            gastosPorCategoria: gastCat.rows,
            comprasTotal: comprasT.rows[0].total,
            ventaCosto: c.venta_costo,
            devolucionCosto: c.devol_costo,
            mermaCosto: c.merma_costo,
            ingresoEsperado: Number(esp.filas) === 0 ? null : esp.esperado,
            ingresosComparables: comparables.rows[0].total,
            diasSinIngreso: sinIngreso.rows.map((r) => String(r.fecha).slice(0, 10)),
            serieIngresos: sIng.rows,
            serieCompras: sCom.rows,
            serieGastos: sGas.rows,
            serieCosto: sCosto.rows,
        };
    }
}
