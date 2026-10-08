// Ajustes que exigen autorización: descuentos y cortesías en una cuenta abierta, y anulación de una cuenta cobrada.
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { revertirPorReferencia } from "../movimientos/aplicarConsumo.js";
import { registrarAutorizacion } from "./pos.autorizacion.js";
import { calcularTotales, descuentoDeRenglon, diferenciaPagos, mismosPagos, normalizarPagos, repartirDescuento } from "./pos.logic.js";

const aPesos = (c) => c / 100;
const aCentavos = (n) => Math.round(Number(n) * 100);

export default class PosAjustesRepository {
    constructor(cuentasRepository, movimientoRepository) {
        this.cuentas = cuentasRepository;
        this.movimientoRepository = movimientoRepository;
    }

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

    async #cuentaAbierta(client, empresa_id, id) {
        const cuenta = (await client.query("SELECT id, estado FROM pos_cuentas WHERE id = $1 AND empresa_id = $2 FOR UPDATE", [id, empresa_id])).rows[0];
        if (!cuenta) throw ApiError.notFound("Cuenta no encontrada");
        if (cuenta.estado !== "ABIERTA") throw ApiError.conflict("La cuenta ya no está abierta: los descuentos solo se aplican antes de cobrar");
        return cuenta;
    }

    // Descuento, cortesía o quitar el descuento de UN renglón (pendiente o enviado).
    async descuentoItem(empresa_id, cuenta_id, item_id, { tipo, valor, motivo }, { autorizador_id, solicitante_id }) {
        await this.#tx(async (client) => {
            await this.#cuentaAbierta(client, empresa_id, cuenta_id);
            const item = (await client.query("SELECT * FROM pos_cuenta_items WHERE id = $1 AND cuenta_id = $2 FOR UPDATE", [item_id, cuenta_id])).rows[0];
            if (!item) throw ApiError.notFound("Renglón no encontrado");
            if (item.estado === "CANCELADO") throw ApiError.conflict("El renglón está cancelado");
            const r = descuentoDeRenglon(item, { tipo, valor });
            await client.query(
                "UPDATE pos_cuenta_items SET descuento = $2, cortesia = $3, autorizado_por = $4, motivo = $5 WHERE id = $1",
                [item_id, r.descuento, r.cortesia, tipo === "QUITAR" ? null : autorizador_id, tipo === "QUITAR" ? null : motivo],
            );
            await registrarAutorizacion(client, {
                empresa_id, cuenta_id, item_id, tipo: tipo === "CORTESIA" ? "CORTESIA" : tipo === "QUITAR" ? "QUITAR_DESCUENTO" : "DESCUENTO",
                monto: r.importe, motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id,
            });
        });
        return this.cuentas.obtener(empresa_id, cuenta_id);
    }

    // Descuento o cortesía a toda la cuenta (sustituye los descuentos que tuvieran los renglones).
    async descuentoCuenta(empresa_id, cuenta_id, { tipo, valor, motivo }, { autorizador_id, solicitante_id }) {
        await this.#tx(async (client) => {
            await this.#cuentaAbierta(client, empresa_id, cuenta_id);
            const items = (await client.query("SELECT * FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado <> 'CANCELADO' ORDER BY id FOR UPDATE", [cuenta_id])).rows;
            const antes = calcularTotales(items).descuento;
            const reparto = repartirDescuento(items, { tipo, valor });
            for (const r of reparto) {
                await client.query(
                    "UPDATE pos_cuenta_items SET descuento = $2, cortesia = $3, autorizado_por = $4, motivo = $5 WHERE id = $1",
                    [r.id, r.descuento, r.cortesia, tipo === "QUITAR" ? null : autorizador_id, tipo === "QUITAR" ? null : motivo],
                );
            }
            const despues = calcularTotales((await client.query("SELECT * FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado <> 'CANCELADO'", [cuenta_id])).rows).descuento;
            await registrarAutorizacion(client, {
                empresa_id, cuenta_id, tipo: tipo === "CORTESIA" ? "CORTESIA" : tipo === "QUITAR" ? "QUITAR_DESCUENTO" : "DESCUENTO",
                monto: Math.max(0, aPesos(aCentavos(despues) - aCentavos(antes))), motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id,
            });
        });
        return this.cuentas.obtener(empresa_id, cuenta_id);
    }

    // Anula una cuenta COBRADA: regresa el inventario (DEVOLUCION al mismo costo), marca los pagos como anulados,
    // registra el dinero devuelto en el turno de quien lo entrega y, si el turno de la venta ya cerró, ajusta los
    // ingresos que el corte mandó a Finanzas. El efectivo devuelto sale del cajón de quien anula (necesita caja abierta).
    async anular(empresa_id, cuenta_id, { motivo }, { autorizador_id, solicitante_id }) {
        const inventario = await this.#tx(async (client) => {
            const cuenta = (await client.query("SELECT id, folio, estado, turno_id, total FROM pos_cuentas WHERE id = $1 AND empresa_id = $2 FOR UPDATE", [cuenta_id, empresa_id])).rows[0];
            if (!cuenta) throw ApiError.notFound("Cuenta no encontrada");
            if (cuenta.estado === "ANULADA") throw ApiError.conflict("La cuenta ya fue anulada");
            if (cuenta.estado !== "PAGADA") throw ApiError.conflict("Solo se anulan cuentas cobradas; una cuenta abierta se cancela");

            const pagos = (await client.query("SELECT * FROM pos_pagos WHERE cuenta_id = $1 AND NOT anulado ORDER BY id FOR UPDATE", [cuenta_id])).rows;
            const turnoVenta = cuenta.turno_id ? (await client.query("SELECT id, estado FROM pos_turnos WHERE id = $1 FOR UPDATE", [cuenta.turno_id])).rows[0] : null;
            const miTurno = (await client.query("SELECT id FROM pos_turnos WHERE empresa_id = $1 AND usuario_id = $2 AND estado = 'ABIERTO' FOR SHARE", [empresa_id, solicitante_id])).rows[0];
            if (pagos.some((p) => p.metodo === "EFECTIVO") && !miTurno) throw ApiError.conflict("Abre tu caja para registrar la devolución de efectivo");

            // Si el corte de la venta ya se cerró, sus ingresos ya están en Finanzas: se descuenta lo devuelto.
            if (turnoVenta?.estado === "CERRADO") {
                const porMetodo = new Map();
                for (const p of pagos) porMetodo.set(p.metodo, (porMetodo.get(p.metodo) ?? 0) + aCentavos(p.monto));
                for (const [metodo, devueltoC] of porMetodo) {
                    if (devueltoC === 0) continue;
                    const ing = (await client.query("SELECT id, monto FROM ingresos WHERE pos_turno_id = $1 AND metodo_pago = $2 AND NOT anulado FOR UPDATE", [turnoVenta.id, metodo])).rows[0];
                    if (!ing) continue;
                    const quedaC = aCentavos(ing.monto) - devueltoC;
                    const nota = ` · anulación del folio ${cuenta.folio}`;
                    if (quedaC <= 0) {
                        await client.query("UPDATE ingresos SET anulado = true, anulado_at = now(), anulado_por = $2, motivo_anulacion = $3 WHERE id = $1", [ing.id, autorizador_id, `Anulación de la cuenta folio ${cuenta.folio}: ${motivo}`]);
                    } else {
                        await client.query("UPDATE ingresos SET monto = $2, nota = COALESCE(nota, '') || $3 WHERE id = $1", [ing.id, aPesos(quedaC), nota]);
                    }
                }
            }

            for (const p of pagos) {
                await client.query("UPDATE pos_pagos SET anulado = true WHERE id = $1", [p.id]);
                await client.query(
                    "INSERT INTO pos_devoluciones (empresa_id, cuenta_id, pago_id, turno_id, metodo, monto, propina, usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                    [empresa_id, cuenta_id, p.id, miTurno?.id ?? null, p.metodo, p.monto, p.propina, solicitante_id],
                );
            }
            const revertidos = await revertirPorReferencia(client, this.movimientoRepository, empresa_id, {
                referencia_tipo: "POS_CUENTA", referencia_id: cuenta_id, motivo: `Anulación de venta POS folio ${cuenta.folio}`, usuario_id: autorizador_id,
            });
            await client.query(
                "UPDATE pos_cuentas SET estado = 'ANULADA', anulada_at = now(), anulada_por = $2, motivo_cancelacion = $3 WHERE id = $1",
                [cuenta_id, autorizador_id, motivo],
            );
            await registrarAutorizacion(client, { empresa_id, cuenta_id, tipo: "ANULAR_CUENTA", monto: Number(cuenta.total ?? 0), motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id });
            return revertidos;
        });
        return { ...(await this.cuentas.obtener(empresa_id, cuenta_id)), movimientos_revertidos: inventario };
    }

    // Corrige CÓMO se pagó una cuenta ya cobrada (método, monto, propina o referencia) sin anularla: el total de la
    // venta no cambia, así que el inventario tampoco. Si el corte del turno de la venta ya cerró, su cierre original
    // queda intacto: la corrección se guarda aparte (se suma al verlo) y se ajustan los ingresos que mandó a Finanzas.
    async corregirPago(empresa_id, cuenta_id, { pagos, motivo }, { autorizador_id, solicitante_id }) {
        const correccion = await this.#tx(async (client) => {
            const cuenta = (await client.query("SELECT id, folio, estado, turno_id, total FROM pos_cuentas WHERE id = $1 AND empresa_id = $2 FOR UPDATE", [cuenta_id, empresa_id])).rows[0];
            if (!cuenta) throw ApiError.notFound("Cuenta no encontrada");
            if (cuenta.estado === "ANULADA") throw ApiError.conflict("La venta está anulada: ya no se puede corregir su pago");
            if (cuenta.estado !== "PAGADA") throw ApiError.conflict("Solo se corrige el pago de una cuenta cobrada");

            const antes = (await client.query("SELECT * FROM pos_pagos WHERE cuenta_id = $1 AND NOT anulado ORDER BY id FOR UPDATE", [cuenta_id])).rows;
            if (antes.length === 0) throw ApiError.badRequest("Esta cuenta se cerró sin cobro (total $0): no hay pago que corregir");
            const turno = cuenta.turno_id ? (await client.query("SELECT id, estado, fecha_negocio FROM pos_turnos WHERE id = $1 FOR UPDATE", [cuenta.turno_id])).rows[0] : null;

            // Mismas reglas que al cobrar: los montos suman exactamente el total de la cuenta.
            const cobro = normalizarPagos(Number(cuenta.total), pagos);
            const antesLimpio = antes.map((p) => ({ metodo: p.metodo, monto: Number(p.monto), propina: Number(p.propina), recibido: p.recibido === null ? null : Number(p.recibido), cambio: p.cambio === null ? null : Number(p.cambio), referencia: p.referencia }));
            if (mismosPagos(antesLimpio, cobro.pagos)) throw ApiError.badRequest("No hay cambios: los pagos son los mismos que ya tiene la cuenta");
            const delta = diferenciaPagos(antesLimpio, cobro.pagos);
            const turnoCerrado = turno?.estado === "CERRADO";

            // Los pagos nuevos quedan en el mismo turno, con quien cobró y la hora original.
            await client.query("DELETE FROM pos_pagos WHERE cuenta_id = $1 AND NOT anulado", [cuenta_id]);
            for (const p of cobro.pagos) {
                await client.query(
                    `INSERT INTO pos_pagos (empresa_id, cuenta_id, turno_id, usuario_id, metodo, monto, propina, recibido, cambio, referencia, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                    [empresa_id, cuenta_id, antes[0].turno_id, antes[0].usuario_id, p.metodo, p.monto, p.propina, p.recibido, p.cambio, p.referencia, antes[0].created_at],
                );
            }
            await client.query("UPDATE pos_cuentas SET propina = $2 WHERE id = $1", [cuenta_id, cobro.propina]);

            // Corte ya cerrado: sus ingresos ya están en Finanzas, se mueve lo que cambió en cada método.
            if (turnoCerrado) {
                for (const m of delta.por_metodo) {
                    const deltaC = aCentavos(m.monto);
                    if (deltaC === 0) continue;
                    const ing = (await client.query("SELECT id, monto FROM ingresos WHERE pos_turno_id = $1 AND metodo_pago = $2 AND NOT anulado FOR UPDATE", [turno.id, m.metodo])).rows[0];
                    const nota = ` · corrección del pago del folio ${cuenta.folio}`;
                    if (!ing) {
                        if (deltaC > 0) {
                            await client.query(
                                `INSERT INTO ingresos (empresa_id, fecha, metodo_pago, monto, concepto, nota, usuario_id, pos_turno_id)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                                [empresa_id, turno.fecha_negocio, m.metodo, aPesos(deltaC), `Corte de caja · turno ${turno.id}`, `Corrección del pago del folio ${cuenta.folio}`, autorizador_id, turno.id],
                            );
                        }
                        continue;
                    }
                    const quedaC = aCentavos(ing.monto) + deltaC;
                    if (quedaC <= 0) {
                        await client.query("UPDATE ingresos SET anulado = true, anulado_at = now(), anulado_por = $2, motivo_anulacion = $3 WHERE id = $1", [ing.id, autorizador_id, `Corrección del pago del folio ${cuenta.folio}: ${motivo}`]);
                    } else {
                        await client.query("UPDATE ingresos SET monto = $2, nota = COALESCE(nota, '') || $3 WHERE id = $1", [ing.id, aPesos(quedaC), nota]);
                    }
                }
            }

            // Una copia del ticket debe salir con el pago correcto.
            await client.query(
                `UPDATE pos_impresiones SET payload = payload || $3::jsonb WHERE empresa_id = $1 AND tipo = 'TICKET' AND referencia_id = $2`,
                [empresa_id, cuenta_id, JSON.stringify({ pagos: cobro.pagos, propina: cobro.propina, cambio: cobro.cambio, abrir_cajon: false, corregido: true })],
            );

            const r = await client.query(
                `INSERT INTO pos_correcciones_pago (empresa_id, cuenta_id, turno_id, turno_cerrado, motivo, autorizado_por, solicitado_por, antes, despues, delta_efectivo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, turno_cerrado, delta_efectivo, created_at`,
                [empresa_id, cuenta_id, turno?.id ?? null, turnoCerrado, motivo, autorizador_id, solicitante_id, JSON.stringify(antesLimpio), JSON.stringify(cobro.pagos), delta.efectivo],
            );
            await registrarAutorizacion(client, { empresa_id, cuenta_id, tipo: "CORREGIR_PAGO", monto: Number(cuenta.total ?? 0), motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id });
            return r.rows[0];
        });
        return { ...(await this.cuentas.obtener(empresa_id, cuenta_id)), correccion };
    }
}
