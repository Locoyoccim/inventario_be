import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { aplicarCorrecciones, calcularCorte, diferenciaEfectivo, payloadCorte } from "./pos.logic.js";

const Q = {
    TURNO: `SELECT t.id, t.empresa_id, t.usuario_id, u.nombre AS cajero, t.fecha_negocio, t.fondo_inicial, t.abierto_at, t.cerrado_at, t.estado,
                   t.efectivo_esperado, t.efectivo_contado, t.diferencia, t.propinas_entregadas, t.nota_cierre, t.resumen, uc.nombre AS cerrado_por
            FROM pos_turnos t JOIN usuarios u ON u.id = t.usuario_id LEFT JOIN usuarios uc ON uc.id = t.cerrado_por
            WHERE t.id = $1 AND t.empresa_id = $2`,
    POR_METODO: `SELECT metodo, COUNT(DISTINCT cuenta_id)::int AS cuentas, SUM(monto) AS monto, SUM(propina) AS propina
                 FROM pos_pagos WHERE turno_id = $1 AND NOT anulado GROUP BY metodo`,
    // Lo que entró al cajón cuenta aunque la venta se anule después; el efectivo devuelto se resta aparte.
    EFECTIVO_INGRESADO: `SELECT COALESCE(SUM(monto + propina), 0) AS n FROM pos_pagos WHERE turno_id = $1 AND metodo = 'EFECTIVO'`,
    DEVOLUCIONES_EFECTIVO: `SELECT COALESCE(SUM(monto + propina), 0) AS n FROM pos_devoluciones WHERE turno_id = $1 AND metodo = 'EFECTIVO'`,
    ANULADAS: `SELECT c.id, c.folio, c.tipo, m.nombre AS mesa, c.nombre_cliente, c.total, c.motivo_cancelacion AS motivo, c.anulada_at, ua.nombre AS anulada_por
               FROM pos_cuentas c LEFT JOIN mesas m ON m.id = c.mesa_id LEFT JOIN usuarios ua ON ua.id = c.anulada_por
               WHERE c.turno_id = $1 AND c.estado = 'ANULADA' ORDER BY c.anulada_at`,
    AUTORIZACIONES: `SELECT a.id, a.tipo, a.monto, a.motivo, a.created_at, c.folio, ua.nombre AS autorizado_por, us.nombre AS solicitado_por
                     FROM pos_autorizaciones a LEFT JOIN pos_cuentas c ON c.id = a.cuenta_id
                     JOIN usuarios ua ON ua.id = a.autorizado_por LEFT JOIN usuarios us ON us.id = a.solicitado_por
                     WHERE a.empresa_id = $1 AND a.created_at >= $2 AND a.created_at <= $3 ORDER BY a.id`,
    VENTAS: `SELECT c.id, c.folio, c.tipo, m.nombre AS mesa, c.nombre_cliente, c.total, c.propina, c.cerrada_at,
                    (SELECT string_agg(DISTINCT p.metodo, ',' ORDER BY p.metodo) FROM pos_pagos p WHERE p.cuenta_id = c.id) AS metodos
             FROM pos_cuentas c LEFT JOIN mesas m ON m.id = c.mesa_id
             WHERE c.turno_id = $1 AND c.estado = 'PAGADA' ORDER BY c.cerrada_at, c.id`,
    // Cuentas abiertas con algo que cobrar (una cuenta vacía no estorba al cerrar).
    ABIERTAS: `SELECT COUNT(*)::int AS n FROM pos_cuentas c
               WHERE c.empresa_id = $1 AND c.estado = 'ABIERTA'
                 AND EXISTS (SELECT 1 FROM pos_cuenta_items i WHERE i.cuenta_id = c.id AND i.estado <> 'CANCELADO')`,
    OTROS_TURNOS: `SELECT COUNT(*)::int AS n FROM pos_turnos WHERE empresa_id = $1 AND estado = 'ABIERTO' AND id <> $2`,
    CORRECCIONES: `SELECT k.id, k.cuenta_id, c.folio, k.motivo, k.turno_cerrado, k.antes, k.despues, k.delta_efectivo, k.created_at,
                          ua.nombre AS autorizado_por, us.nombre AS solicitado_por
                   FROM pos_correcciones_pago k JOIN pos_cuentas c ON c.id = k.cuenta_id
                   JOIN usuarios ua ON ua.id = k.autorizado_por LEFT JOIN usuarios us ON us.id = k.solicitado_por
                   WHERE k.turno_id = $1 ORDER BY k.id`,
    NEGOCIO: `SELECT nombre FROM empresas WHERE id = $1`,
    IMPRESORA_TICKETS: `SELECT id FROM impresoras WHERE empresa_id = $1 AND es_ticket AND activo ORDER BY id LIMIT 1`,
};

const aCentavos = (n) => Math.round(Number(n) * 100);
const numerico = (t) => ({ ...t, fondo_inicial: Number(t.fondo_inicial) });

export default class PosTurnosRepository {
    async #tx(fn) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    // Un cajero ve y cierra su turno; quien autoriza (supervisor/Admin) cualquiera.
    #verificarAcceso(turno, usuario) {
        if (turno.usuario_id !== usuario.id && !usuario.puedeAutorizar) throw ApiError.forbidden("Solo puedes consultar tu propio turno; un supervisor puede ver cualquiera");
    }

    // Un turno cerrado conserva su corte tal como se cerró (las anulaciones posteriores se ven en `anuladas`);
    // uno abierto se calcula con lo vigente.
    async #resumen(db, empresa_id, turno, propinas_entregadas) {
        if (turno.estado === "CERRADO" && turno.resumen) return { devoluciones_efectivo: 0, ...turno.resumen };
        const [filas, ingresado, devuelto] = await Promise.all([
            db.query(Q.POR_METODO, [turno.id]),
            db.query(Q.EFECTIVO_INGRESADO, [turno.id]),
            db.query(Q.DEVOLUCIONES_EFECTIVO, [turno.id]),
        ]);
        return calcularCorte({
            fondo: turno.fondo_inicial, filas: filas.rows, propinas_entregadas,
            efectivo_ingresado: ingresado.rows[0].n, devoluciones_efectivo: devuelto.rows[0].n,
        });
    }

    async listar(empresa_id, usuario, limit = 30) {
        const r = await pool.query(
            `SELECT t.id, t.usuario_id, u.nombre AS cajero, t.fecha_negocio, t.fondo_inicial, t.abierto_at, t.cerrado_at, t.estado,
                    t.efectivo_esperado, t.efectivo_contado, t.diferencia,
                    COALESCE((SELECT SUM(p.monto) FROM pos_pagos p WHERE p.turno_id = t.id AND NOT p.anulado), 0) AS ventas,
                    (SELECT COUNT(*)::int FROM pos_correcciones_pago k WHERE k.turno_id = t.id AND k.turno_cerrado) AS correcciones_posteriores,
                    COALESCE((SELECT SUM(k.delta_efectivo) FROM pos_correcciones_pago k WHERE k.turno_id = t.id AND k.turno_cerrado), 0) AS ajuste_efectivo
             FROM pos_turnos t JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.empresa_id = $1 AND ($2::boolean OR t.usuario_id = $3)
             ORDER BY t.id DESC LIMIT $4`,
            [empresa_id, Boolean(usuario.puedeAutorizar), usuario.id, limit],
        );
        // Con correcciones de pago hechas después del cierre, la diferencia vigente es contado − esperado ajustado
        // (la columna `diferencia` sigue siendo la del cierre original).
        return r.rows.map(({ ajuste_efectivo, ...t }) => {
            if (t.estado !== "CERRADO" || t.correcciones_posteriores === 0) return { ...t, diferencia_ajustada: null };
            const esperado = aCentavos(t.efectivo_esperado) + aCentavos(ajuste_efectivo);
            return { ...t, diferencia_ajustada: (aCentavos(t.efectivo_contado) - esperado) / 100 };
        });
    }

    // Corte del turno: abierto es un corte parcial ("corte X"); cerrado, el definitivo.
    async corte(empresa_id, turno_id, usuario) {
        const turno = (await pool.query(Q.TURNO, [turno_id, empresa_id])).rows[0];
        if (!turno) throw ApiError.notFound("Turno no encontrado");
        this.#verificarAcceso(turno, usuario);
        const t = numerico(turno);
        const hasta = turno.cerrado_at ?? new Date();
        const [corte, ventas, anuladas, autorizaciones, abiertas, otros, correccionesRes] = await Promise.all([
            this.#resumen(pool, empresa_id, t, t.propinas_entregadas),
            pool.query(Q.VENTAS, [turno_id]),
            pool.query(Q.ANULADAS, [turno_id]),
            pool.query(Q.AUTORIZACIONES, [empresa_id, turno.abierto_at, hasta]),
            pool.query(Q.ABIERTAS, [empresa_id]),
            pool.query(Q.OTROS_TURNOS, [empresa_id, turno_id]),
            pool.query(Q.CORRECCIONES, [turno_id]),
        ]);
        const correcciones = correccionesRes.rows.map((c) => ({ ...c, delta_efectivo: Number(c.delta_efectivo) }));
        // Un corte cerrado no cambia; lo corregido después del cierre se ve aparte, ya sumado.
        const ajustado = t.estado === "CERRADO" ? aplicarCorrecciones(corte, t.efectivo_contado === null ? null : Number(t.efectivo_contado), correcciones) : null;
        return {
            turno: { ...t, resumen: undefined, propinas_entregadas: Number(t.propinas_entregadas) },
            corte,
            correcciones,
            ajustado,
            ventas: ventas.rows,
            anuladas: anuladas.rows,
            autorizaciones: autorizaciones.rows,
            cuentas_abiertas: abiertas.rows[0].n,
            es_ultimo_turno: otros.rows[0].n === 0,
        };
    }

    // Cierra la caja en una transacción: calcula el esperado, guarda el conteo y la diferencia, y genera los
    // ingresos del día por método (sin propinas). Si queda trabajo abierto y es la última caja, exige `forzar`.
    async cerrar(empresa_id, turno_id, { efectivo_contado, propinas_entregadas = 0, nota, forzar = false }, usuario) {
        const salida = await this.#tx(async (client) => {
            const turno = (await client.query(`${Q.TURNO} FOR UPDATE OF t`, [turno_id, empresa_id])).rows[0];
            if (!turno) throw ApiError.notFound("Turno no encontrado");
            this.#verificarAcceso(turno, usuario);
            if (turno.estado !== "ABIERTO") throw ApiError.conflict("El turno ya está cerrado");
            const t = numerico(turno);

            const abiertas = (await client.query(Q.ABIERTAS, [empresa_id])).rows[0].n;
            const otros = (await client.query(Q.OTROS_TURNOS, [empresa_id, turno_id])).rows[0].n;
            if (abiertas > 0 && otros === 0 && !forzar) {
                throw ApiError.conflict(`Hay ${abiertas} cuenta(s) abierta(s) con productos y esta es la última caja abierta. Cóbralas o confirma el cierre.`, { cuentas_abiertas: abiertas });
            }

            const corte = await this.#resumen(client, empresa_id, t, propinas_entregadas);
            if (corte.propinas_entregadas > corte.propinas) throw ApiError.badRequest(`No puedes entregar más propinas (${corte.propinas_entregadas.toFixed(2)}) de las cobradas (${corte.propinas.toFixed(2)})`);
            const diferencia = diferenciaEfectivo(efectivo_contado, corte.efectivo_esperado);

            await client.query(
                `UPDATE pos_turnos SET estado = 'CERRADO', cerrado_at = now(), cerrado_por = $2, efectivo_contado = $3, efectivo_esperado = $4,
                        diferencia = $5, propinas_entregadas = $6, nota_cierre = $7, resumen = $8 WHERE id = $1`,
                [turno_id, usuario.id, efectivo_contado, corte.efectivo_esperado, diferencia, corte.propinas_entregadas, nota || null, JSON.stringify(corte)],
            );

            // Ingresos de Finanzas: lo vendido por método (la propina no es ingreso del negocio).
            const ingresos = [];
            for (const m of corte.por_metodo.filter((x) => x.monto > 0)) {
                const r = await client.query(
                    `INSERT INTO ingresos (empresa_id, fecha, metodo_pago, monto, concepto, nota, usuario_id, pos_turno_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, metodo_pago, monto`,
                    [empresa_id, turno.fecha_negocio, m.metodo, m.monto, `Corte de caja · turno ${turno_id}`, `${m.cuentas} cuenta(s) cobradas por ${turno.cajero}`, usuario.id, turno_id],
                );
                ingresos.push(r.rows[0]);
            }

            const cerrado = (await client.query(Q.TURNO, [turno_id, empresa_id])).rows[0];
            const impresion = await this.#encolarCorte(client, empresa_id, cerrado, corte);
            return { ingresos, impresion };
        });
        return { ...(await this.corte(empresa_id, turno_id, usuario)), ...salida };
    }

    async imprimirCorte(empresa_id, turno_id, usuario) {
        const turno = (await pool.query(Q.TURNO, [turno_id, empresa_id])).rows[0];
        if (!turno) throw ApiError.notFound("Turno no encontrado");
        this.#verificarAcceso(turno, usuario);
        const corte = await this.#resumen(pool, empresa_id, numerico(turno), turno.propinas_entregadas);
        // Cerrado con correcciones de pago posteriores: se imprime ya ajustado y se aclara cómo se había cerrado.
        let ajuste = null;
        if (turno.estado === "CERRADO") {
            const correcciones = (await pool.query(Q.CORRECCIONES, [turno_id])).rows;
            const ajustado = aplicarCorrecciones(corte, Number(turno.efectivo_contado), correcciones);
            if (ajustado) {
                ajuste = {
                    correcciones: correcciones.filter((c) => c.turno_cerrado).length,
                    esperado_original: Number(turno.efectivo_esperado),
                    diferencia_original: Number(turno.diferencia),
                    corte: ajustado.corte,
                    diferencia: ajustado.diferencia,
                };
            }
        }
        return this.#encolarCorte(pool, empresa_id, turno, ajuste ? ajuste.corte : corte, ajuste);
    }

    async #encolarCorte(db, empresa_id, turno, corte, ajuste = null) {
        const negocio = (await db.query(Q.NEGOCIO, [empresa_id])).rows[0]?.nombre ?? "";
        const cerrado = turno.estado === "CERRADO";
        const payload = payloadCorte({
            negocio, turno, cajero: turno.cajero, corte,
            contado: cerrado ? Number(turno.efectivo_contado) : null,
            diferencia: cerrado ? (ajuste ? ajuste.diferencia : Number(turno.diferencia)) : null,
            nota: turno.nota_cierre,
            ajuste: ajuste ? { correcciones: ajuste.correcciones, esperado_original: ajuste.esperado_original, diferencia_original: ajuste.diferencia_original } : null,
        });
        const impresora = (await db.query(Q.IMPRESORA_TICKETS, [empresa_id])).rows[0];
        const r = await db.query(
            `INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, estado, error, payload)
             VALUES ($1,'CORTE',$2,$3,$4,$5,$6) RETURNING id, estado`,
            [empresa_id, turno.id, impresora?.id ?? null, impresora ? "PENDIENTE" : "SIN_IMPRESORA", impresora ? null : "Sin impresora configurada para tickets", JSON.stringify(payload)],
        );
        return { impresion_id: r.rows[0].id, impresion_estado: r.rows[0].estado };
    }
}
