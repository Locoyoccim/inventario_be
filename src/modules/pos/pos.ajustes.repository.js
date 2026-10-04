// Ajustes que exigen autorización: descuentos y cortesías en una cuenta abierta, y anulación de una cuenta cobrada.
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { revertirPorReferencia } from "../movimientos/aplicarConsumo.js";
import { registrarAutorizacion } from "./pos.autorizacion.js";
import { calcularTotales, descuentoDeRenglon, repartirDescuento } from "./pos.logic.js";

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

    // Lo autorizado en un rango de tiempo (para el corte): quién, qué, cuánto y por qué.
    async autorizaciones(empresa_id, desde, hasta) {
        const r = await pool.query(
            `SELECT a.id, a.tipo, a.monto, a.motivo, a.created_at, c.folio, ua.nombre AS autorizado_por, us.nombre AS solicitado_por
             FROM pos_autorizaciones a
             LEFT JOIN pos_cuentas c ON c.id = a.cuenta_id
             JOIN usuarios ua ON ua.id = a.autorizado_por LEFT JOIN usuarios us ON us.id = a.solicitado_por
             WHERE a.empresa_id = $1 AND a.created_at >= $2 AND a.created_at <= $3 ORDER BY a.id`,
            [empresa_id, desde, hasta],
        );
        return r.rows;
    }
}
