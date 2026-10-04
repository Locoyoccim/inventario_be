import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { hoyEmpresa } from "../../utils/zonaHoraria.js";
import { aplicarConsumo, cargarContextoConsumo } from "../movimientos/aplicarConsumo.js";
import { exigirAutorizador, registrarAutorizacion } from "./pos.autorizacion.js";
import { agruparPorArea, calcularTotales, normalizarPagos, payloadComanda, payloadPrecuenta, payloadTicket } from "./pos.logic.js";
import { diaImportadoCsv } from "./pos.dias.js";

const CUENTA_COLS = `c.id, c.empresa_id, c.folio, c.tipo, c.mesa_id, m.nombre AS mesa, c.reservacion_id, c.nombre_cliente,
    c.personas, c.mesero_id, u.nombre AS mesero, c.turno_id, c.estado, c.unida_a, c.dividida_de, c.fecha_negocio,
    c.abierta_at, c.actualizada_at, c.cerrada_at, c.motivo_cancelacion, c.propina, c.anulada_at`;

const ITEM_COLS = `i.id, i.cuenta_id, i.receta_id, i.producto_id, i.nombre, i.precio_unitario, i.iva_pct, i.precio_incluye_iva,
    i.cantidad, i.notas, i.estado, i.area_id, a.nombre AS area, i.comanda_id, i.descuento, i.cortesia, i.autorizado_por,
    i.motivo, i.created_at`;

const Q = {
    CUENTA: `SELECT ${CUENTA_COLS} FROM pos_cuentas c
             LEFT JOIN mesas m ON m.id = c.mesa_id LEFT JOIN usuarios u ON u.id = c.mesero_id
             WHERE c.id = $1 AND c.empresa_id = $2`,
    LOCK_CUENTA: `SELECT id, empresa_id, folio, tipo, mesa_id, nombre_cliente, personas, mesero_id, estado, next_comanda
                  FROM pos_cuentas WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
    ITEMS: `SELECT ${ITEM_COLS} FROM pos_cuenta_items i LEFT JOIN areas_preparacion a ON a.id = i.area_id
            WHERE i.cuenta_id = $1 ORDER BY i.id`,
    FOLIO: `INSERT INTO pos_folios (empresa_id, ultimo) VALUES ($1, 1)
            ON CONFLICT (empresa_id) DO UPDATE SET ultimo = pos_folios.ultimo + 1 RETURNING ultimo`,
    FECHA_NEGOCIO: `SELECT fecha_negocio FROM pos_turnos WHERE empresa_id = $1 AND estado = 'ABIERTO' ORDER BY id DESC LIMIT 1`,
    NEGOCIO: `SELECT nombre FROM empresas WHERE id = $1`,
    MESA_FOR_UPDATE: `SELECT id, nombre FROM mesas WHERE id = $1 AND empresa_id = $2 AND activo FOR UPDATE`,
    PAGOS: `SELECT p.id, p.metodo, p.monto, p.propina, p.recibido, p.cambio, p.referencia, p.anulado, p.created_at, u.nombre AS cobrador
            FROM pos_pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id WHERE p.cuenta_id = $1 ORDER BY p.id`,
    // FOR SHARE: un cierre de turno (FOR UPDATE) espera a los cobros en curso y los siguientes ya no ven el turno abierto.
    TURNO_ABIERTO: `SELECT id, fecha_negocio FROM pos_turnos WHERE empresa_id = $1 AND usuario_id = $2 AND estado = 'ABIERTO' FOR SHARE`,
    MESA_OCUPADA: `SELECT id, folio FROM pos_cuentas WHERE mesa_id = $1 AND estado = 'ABIERTA' LIMIT 1`,
};

const fechaNegocio = async (db, empresa_id) => (await db.query(Q.FECHA_NEGOCIO, [empresa_id])).rows[0]?.fecha_negocio ?? await hoyEmpresa(empresa_id, db);
const aCentavos = (n) => Math.round(Number(n) * 100);

export default class PosCuentasRepository {
    constructor(posConfigRepository, movimientoRepository) {
        this.posConfig = posConfigRepository;
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

    async #bloquear(client, empresa_id, id) {
        const cuenta = (await client.query(Q.LOCK_CUENTA, [id, empresa_id])).rows[0];
        if (!cuenta) throw ApiError.notFound("Cuenta no encontrada");
        if (cuenta.estado !== "ABIERTA") throw ApiError.conflict("La cuenta ya no está abierta");
        return cuenta;
    }

    async obtener(empresa_id, id, db = pool) {
        const cuenta = (await db.query(Q.CUENTA, [id, empresa_id])).rows[0];
        if (!cuenta) throw ApiError.notFound("Cuenta no encontrada");
        const items = (await db.query(Q.ITEMS, [id])).rows;
        const cobrada = ["PAGADA", "ANULADA"].includes(cuenta.estado);
        const pagos = cobrada ? (await db.query(Q.PAGOS, [id])).rows : [];
        // Correcciones de pago hechas después del cobro (quién, cuándo, por qué) y si el corte de la venta ya cerró.
        const correcciones = cobrada
            ? (await db.query(
                  `SELECT k.id, k.motivo, k.turno_cerrado, k.created_at, ua.nombre AS autorizado_por
                   FROM pos_correcciones_pago k JOIN usuarios ua ON ua.id = k.autorizado_por WHERE k.cuenta_id = $1 ORDER BY k.id`, [id])).rows
            : [];
        const turnoCerrado = cobrada && cuenta.turno_id
            ? (await db.query("SELECT estado FROM pos_turnos WHERE id = $1", [cuenta.turno_id])).rows[0]?.estado === "CERRADO"
            : false;
        return { ...cuenta, items, totales: calcularTotales(items), pagos, correcciones, turno_cerrado: turnoCerrado };
    }

    // Mapa de mesas con sus cuentas abiertas, más las cuentas para llevar.
    async mapa(empresa_id) {
        await this.#purgarVacias(empresa_id);
        const [mesas, cuentas] = await Promise.all([
            pool.query("SELECT id, nombre, zona, capacidad, orden FROM mesas WHERE empresa_id = $1 AND activo ORDER BY orden, nombre", [empresa_id]),
            pool.query(
                `SELECT ${CUENTA_COLS} FROM pos_cuentas c LEFT JOIN mesas m ON m.id = c.mesa_id LEFT JOIN usuarios u ON u.id = c.mesero_id
                 WHERE c.empresa_id = $1 AND c.estado = 'ABIERTA' ORDER BY c.abierta_at`,
                [empresa_id],
            ),
        ]);
        const ids = cuentas.rows.map((c) => c.id);
        const items = ids.length
            ? (await pool.query(
                  "SELECT cuenta_id, precio_unitario, iva_pct, precio_incluye_iva, cantidad, estado, descuento, cortesia FROM pos_cuenta_items WHERE cuenta_id = ANY($1::int[])",
                  [ids],
              )).rows
            : [];
        const porCuenta = new Map();
        for (const item of items) {
            if (!porCuenta.has(item.cuenta_id)) porCuenta.set(item.cuenta_id, []);
            porCuenta.get(item.cuenta_id).push(item);
        }
        const resumen = (c) => {
            const lista = porCuenta.get(c.id) ?? [];
            return {
                id: c.id, folio: c.folio, tipo: c.tipo, mesa_id: c.mesa_id, nombre_cliente: c.nombre_cliente, personas: c.personas,
                mesero: c.mesero, mesero_id: c.mesero_id, abierta_at: c.abierta_at, actualizada_at: c.actualizada_at,
                total: calcularTotales(lista).total,
                por_enviar: lista.filter((i) => i.estado === "PENDIENTE").reduce((s, i) => s + i.cantidad, 0),
            };
        };
        const abiertas = cuentas.rows.map(resumen);
        return {
            mesas: mesas.rows.map((m) => ({ ...m, cuentas: abiertas.filter((c) => c.mesa_id === m.id) })),
            llevar: abiertas.filter((c) => c.tipo === "LLEVAR"),
        };
    }

    async abrirCuenta(empresa_id, { tipo = "MESA", mesa_id, personas = 1, nombre_cliente, reservacion_id }, usuario_id) {
        const id = await this.#tx(async (client) => {
            if (tipo === "MESA") {
                const mesa = (await client.query(Q.MESA_FOR_UPDATE, [mesa_id, empresa_id])).rows[0];
                if (!mesa) throw ApiError.badRequest("La mesa no existe o está inactiva");
                const ocupada = (await client.query(Q.MESA_OCUPADA, [mesa_id])).rows[0];
                if (ocupada) throw ApiError.conflict(`${mesa.nombre} ya tiene una cuenta abierta (folio ${ocupada.folio})`, { cuenta_id: ocupada.id });
            }
            if (reservacion_id) {
                // FOR UPDATE: dos toques seguidos en "Sentar" no abren dos cuentas para la misma reservación.
                const r = await client.query("SELECT 1 FROM reservaciones WHERE id = $1 AND empresa_id = $2 FOR UPDATE", [reservacion_id, empresa_id]);
                if (r.rowCount === 0) throw ApiError.badRequest("La reservación no existe en la empresa");
                const previa = (await client.query(
                    "SELECT id, folio FROM pos_cuentas WHERE reservacion_id = $1 AND estado <> 'CANCELADA' ORDER BY id DESC LIMIT 1",
                    [reservacion_id],
                )).rows[0];
                if (previa) throw ApiError.conflict(`La reservación ya tiene la cuenta folio ${previa.folio}`, { cuenta_id: previa.id });
            }
            const folio = (await client.query(Q.FOLIO, [empresa_id])).rows[0].ultimo;
            const fecha = await fechaNegocio(client, empresa_id);
            const r = await client.query(
                `INSERT INTO pos_cuentas (empresa_id, folio, tipo, mesa_id, reservacion_id, nombre_cliente, personas, mesero_id, fecha_negocio)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                [empresa_id, folio, tipo, tipo === "MESA" ? mesa_id : null, reservacion_id ?? null, nombre_cliente || null, personas, usuario_id, fecha],
            );
            // Abrir la cuenta de una reservación es sentarla.
            if (reservacion_id) {
                await client.query(
                    "UPDATE reservaciones SET estado = 'sentada', updated_at = now() WHERE id = $1 AND empresa_id = $2 AND estado IN ('pendiente', 'confirmada')",
                    [reservacion_id, empresa_id],
                );
            }
            return r.rows[0].id;
        });
        return this.obtener(empresa_id, id);
    }

    async agregarItems(empresa_id, cuenta_id, lineas, usuario_id) {
        await this.#tx(async (client) => {
            await this.#bloquear(client, empresa_id, cuenta_id);
            const menu = new Map((await this.posConfig.articulosVendibles(client, empresa_id)).map((a) => [`${a.tipo}-${a.id}`, a]));
            for (const l of lineas) {
                const a = menu.get(`${l.tipo}-${l.id}`);
                if (!a) throw ApiError.badRequest("Un artículo ya no está disponible en el menú (inactivo o sin precio)");
                // Mismo artículo sin notas y aún sin enviar: se suma al renglón existente.
                if (!l.notas) {
                    const suma = await client.query(
                        `UPDATE pos_cuenta_items SET cantidad = LEAST(cantidad + $4, 99)
                         WHERE id = (SELECT id FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado = 'PENDIENTE' AND notas IS NULL
                                     AND receta_id IS NOT DISTINCT FROM $2 AND producto_id IS NOT DISTINCT FROM $3 ORDER BY id LIMIT 1)`,
                        [cuenta_id, l.tipo === "RECETA" ? a.id : null, l.tipo === "PRODUCTO" ? a.id : null, l.cantidad],
                    );
                    if (suma.rowCount > 0) continue;
                }
                await client.query(
                    `INSERT INTO pos_cuenta_items (empresa_id, cuenta_id, receta_id, producto_id, nombre, precio_unitario, iva_pct,
                        precio_incluye_iva, cantidad, notas, area_id, creado_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                    [empresa_id, cuenta_id, l.tipo === "RECETA" ? a.id : null, l.tipo === "PRODUCTO" ? a.id : null, a.nombre,
                        a.precio_venta, a.iva_pct, a.precio_incluye_iva, l.cantidad, l.notas || null, a.area_id, usuario_id],
                );
            }
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    async #itemPendiente(client, empresa_id, cuenta_id, item_id) {
        await this.#bloquear(client, empresa_id, cuenta_id);
        const item = (await client.query("SELECT id, estado FROM pos_cuenta_items WHERE id = $1 AND cuenta_id = $2 FOR UPDATE", [item_id, cuenta_id])).rows[0];
        if (!item) throw ApiError.notFound("Renglón no encontrado");
        if (item.estado !== "PENDIENTE") throw ApiError.conflict("El renglón ya se envió a preparación; cancélalo con autorización");
        return item;
    }

    async actualizarItem(empresa_id, cuenta_id, item_id, { cantidad, notas }) {
        await this.#tx(async (client) => {
            await this.#itemPendiente(client, empresa_id, cuenta_id, item_id);
            await client.query(
                `UPDATE pos_cuenta_items SET cantidad = COALESCE($2, cantidad), notas = CASE WHEN $3::boolean THEN NULLIF($4, '') ELSE notas END WHERE id = $1`,
                [item_id, cantidad ?? null, notas !== undefined, notas ?? null],
            );
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    async eliminarItem(empresa_id, cuenta_id, item_id) {
        await this.#tx(async (client) => {
            await this.#itemPendiente(client, empresa_id, cuenta_id, item_id);
            await client.query("DELETE FROM pos_cuenta_items WHERE id = $1", [item_id]);
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    // Un renglón ya enviado no se borra: queda CANCELADO con quién lo autorizó y por qué.
    async cancelarItem(empresa_id, cuenta_id, item_id, motivo, { autorizador_id, solicitante_id }) {
        exigirAutorizador(autorizador_id);
        await this.#tx(async (client) => {
            await this.#bloquear(client, empresa_id, cuenta_id);
            const r = await client.query(
                `UPDATE pos_cuenta_items SET estado = 'CANCELADO', motivo = $3, autorizado_por = $4
                 WHERE id = $1 AND cuenta_id = $2 AND estado = 'ENVIADO' RETURNING id, precio_unitario, cantidad`,
                [item_id, cuenta_id, motivo, autorizador_id],
            );
            if (r.rowCount === 0) throw ApiError.conflict("Solo se cancelan renglones ya enviados; los pendientes se quitan directamente");
            const { precio_unitario, cantidad } = r.rows[0];
            await registrarAutorizacion(client, {
                empresa_id, cuenta_id, item_id, tipo: "CANCELAR_ITEM", monto: Math.round(Number(precio_unitario) * 100) * cantidad / 100,
                motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id,
            });
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    // Resuelve el área real de cada renglón al enviar: si su área se desactivó, va a la predeterminada.
    async #areasActivas(client, empresa_id) {
        const rows = (await client.query("SELECT id, nombre, imprime, es_default FROM areas_preparacion WHERE empresa_id = $1 AND activo", [empresa_id])).rows;
        return { porId: new Map(rows.map((a) => [a.id, a])), predeterminada: rows.find((a) => a.es_default) ?? null };
    }

    async #crearImpresion(client, empresa_id, { tipo, referencia_id, payload, impresora, faltante }) {
        const r = await client.query(
            `INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, estado, error, payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, estado`,
            [empresa_id, tipo, referencia_id, impresora?.id ?? null, impresora ? "PENDIENTE" : "SIN_IMPRESORA", impresora ? null : `Sin impresora configurada para ${faltante}`, JSON.stringify(payload)],
        );
        return r.rows[0];
    }

    async enviar(empresa_id, cuenta_id, usuario_id) {
        const resultado = await this.#tx(async (client) => {
            const cuenta = await this.#bloquear(client, empresa_id, cuenta_id);
            const pendientes = (await client.query(`SELECT ${ITEM_COLS} FROM pos_cuenta_items i LEFT JOIN areas_preparacion a ON a.id = i.area_id
                WHERE i.cuenta_id = $1 AND i.estado = 'PENDIENTE' ORDER BY i.id FOR UPDATE OF i`, [cuenta_id])).rows;
            if (pendientes.length === 0) throw ApiError.badRequest("No hay productos por enviar");

            const { porId, predeterminada } = await this.#areasActivas(client, empresa_id);
            for (const item of pendientes) if (!porId.has(item.area_id) && predeterminada) item.area_id = predeterminada.id;
            const { comandas, sinComanda } = agruparPorArea(pendientes, porId);

            const negocio = (await client.query(Q.NEGOCIO, [empresa_id])).rows[0]?.nombre ?? "";
            const mesa = cuenta.mesa_id ? (await client.query("SELECT nombre FROM mesas WHERE id = $1", [cuenta.mesa_id])).rows[0] : null;
            const mesero = (await client.query("SELECT nombre FROM usuarios WHERE id = $1", [usuario_id])).rows[0]?.nombre ?? null;

            let numero = cuenta.next_comanda;
            const creadas = [];
            for (const { area, items } of comandas) {
                const comanda = (await client.query(
                    "INSERT INTO pos_comandas (empresa_id, cuenta_id, area_id, numero, creado_por) VALUES ($1,$2,$3,$4,$5) RETURNING id, numero",
                    [empresa_id, cuenta_id, area.id, numero, usuario_id],
                )).rows[0];
                await client.query("UPDATE pos_cuenta_items SET estado = 'ENVIADO', comanda_id = $2 WHERE id = ANY($1::int[])", [items.map((i) => i.id), comanda.id]);
                const impresora = (await client.query(
                    "SELECT id FROM impresoras WHERE empresa_id = $1 AND area_id = $2 AND activo ORDER BY id LIMIT 1", [empresa_id, area.id],
                )).rows[0];
                const payload = { ...payloadComanda({ negocio, cuenta, mesa, mesero, numero, area, items }), area_id: area.id };
                const impresion = await this.#crearImpresion(client, empresa_id, { tipo: "COMANDA", referencia_id: comanda.id, payload, impresora, faltante: `el área ${area.nombre}` });
                creadas.push({ id: comanda.id, numero: comanda.numero, area: area.nombre, renglones: items.length, impresion_id: impresion.id, impresion_estado: impresion.estado });
                numero++;
            }
            if (sinComanda.length) await client.query("UPDATE pos_cuenta_items SET estado = 'ENVIADO' WHERE id = ANY($1::int[])", [sinComanda.map((i) => i.id)]);
            await client.query("UPDATE pos_cuentas SET next_comanda = $2 WHERE id = $1", [cuenta_id, numero]);
            return { comandas: creadas, sin_comanda: sinComanda.length };
        });
        return { ...resultado, cuenta: await this.obtener(empresa_id, cuenta_id) };
    }

    async cambiarMesa(empresa_id, cuenta_id, mesa_id) {
        await this.#tx(async (client) => {
            const cuenta = await this.#bloquear(client, empresa_id, cuenta_id);
            if (cuenta.tipo !== "MESA") throw ApiError.badRequest("Solo las cuentas de mesa se pueden cambiar de mesa");
            if (cuenta.mesa_id === mesa_id) throw ApiError.badRequest("La cuenta ya está en esa mesa");
            const mesa = (await client.query(Q.MESA_FOR_UPDATE, [mesa_id, empresa_id])).rows[0];
            if (!mesa) throw ApiError.badRequest("La mesa no existe o está inactiva");
            const ocupada = (await client.query(Q.MESA_OCUPADA, [mesa_id])).rows[0];
            if (ocupada) throw ApiError.conflict(`${mesa.nombre} ya tiene una cuenta abierta (folio ${ocupada.folio}). Para unirlas usa "Juntar cuentas".`);
            await client.query("UPDATE pos_cuentas SET mesa_id = $2 WHERE id = $1", [cuenta_id, mesa_id]);
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    // Salir de una cuenta sin enviar: lo que no se mandó a preparación se descarta y, si la cuenta no tiene nada más
    // (ni enviados, ni comandas, ni autorizaciones, ni otras cuentas ligadas), se borra y la mesa queda libre.
    // El folio se devuelve si era el último; una reservación que se había sentado vuelve a "confirmada".
    async descartar(empresa_id, cuenta_id) {
        const eliminada = await this.#tx(async (client) => {
            const cuenta = await this.#bloquear(client, empresa_id, cuenta_id);
            await client.query("DELETE FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado = 'PENDIENTE'", [cuenta_id]);
            const { usada } = (await client.query(
                `SELECT (EXISTS (SELECT 1 FROM pos_cuenta_items WHERE cuenta_id = $1)
                      OR EXISTS (SELECT 1 FROM pos_comandas WHERE cuenta_id = $1)
                      OR EXISTS (SELECT 1 FROM pos_autorizaciones WHERE cuenta_id = $1)
                      OR EXISTS (SELECT 1 FROM pos_cuentas WHERE unida_a = $1 OR dividida_de = $1)) AS usada`,
                [cuenta_id],
            )).rows[0];
            if (usada) return false;
            const { reservacion_id } = (await client.query("SELECT reservacion_id FROM pos_cuentas WHERE id = $1", [cuenta_id])).rows[0];
            await client.query("DELETE FROM pos_cuentas WHERE id = $1", [cuenta_id]);
            await client.query("UPDATE pos_folios SET ultimo = ultimo - 1 WHERE empresa_id = $1 AND ultimo = $2", [empresa_id, cuenta.folio]);
            if (reservacion_id) {
                await client.query("UPDATE reservaciones SET estado = 'confirmada', updated_at = now() WHERE id = $1 AND empresa_id = $2 AND estado = 'sentada'", [reservacion_id, empresa_id]);
            }
            return true;
        });
        return eliminada ? { eliminada: true, cuenta: null } : { eliminada: false, cuenta: await this.obtener(empresa_id, cuenta_id) };
    }

    // Cuentas vacías que nadie tocó en un buen rato (se cerró la app, se fue la señal…): ocupan la mesa sin razón.
    async #purgarVacias(empresa_id) {
        const { rows } = await pool.query(
            `SELECT c.id FROM pos_cuentas c
             WHERE c.empresa_id = $1 AND c.estado = 'ABIERTA' AND c.actualizada_at < now() - interval '30 minutes'
               AND NOT EXISTS (SELECT 1 FROM pos_cuenta_items i WHERE i.cuenta_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM pos_comandas k WHERE k.cuenta_id = c.id)`,
            [empresa_id],
        );
        for (const { id } of rows) await this.descartar(empresa_id, id).catch(() => {});
    }

    // Nombre o referencia de la cuenta ("Fam. Hernández", "Sr. Herrera") y número de personas.
    async actualizar(empresa_id, cuenta_id, { nombre_cliente, personas }) {
        await this.#tx(async (client) => {
            await this.#bloquear(client, empresa_id, cuenta_id);
            await client.query(
                `UPDATE pos_cuentas SET nombre_cliente = CASE WHEN $2::boolean THEN NULLIF($3, '') ELSE nombre_cliente END,
                                        personas = COALESCE($4, personas) WHERE id = $1`,
                [cuenta_id, nombre_cliente !== undefined, nombre_cliente ?? null, personas ?? null],
            );
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    // Une la cuenta origen en la destino. Se bloquean en orden de id para evitar deadlocks.
    async juntar(empresa_id, origen_id, destino_id) {
        if (origen_id === destino_id) throw ApiError.badRequest("Elige una cuenta distinta para juntar");
        await this.#tx(async (client) => {
            const filas = (await client.query(
                "SELECT id, estado, personas FROM pos_cuentas WHERE id = ANY($1::int[]) AND empresa_id = $2 ORDER BY id FOR UPDATE", [[origen_id, destino_id], empresa_id],
            )).rows;
            const origen = filas.find((f) => f.id === origen_id);
            const destino = filas.find((f) => f.id === destino_id);
            if (!origen || !destino) throw ApiError.notFound("Cuenta no encontrada");
            if (origen.estado !== "ABIERTA" || destino.estado !== "ABIERTA") throw ApiError.conflict("Solo se juntan cuentas abiertas");
            await client.query("UPDATE pos_cuenta_items SET cuenta_id = $2 WHERE cuenta_id = $1", [origen_id, destino_id]);
            await client.query("UPDATE pos_comandas SET cuenta_id = $2 WHERE cuenta_id = $1", [origen_id, destino_id]);
            await client.query("UPDATE pos_cuentas SET personas = personas + $2 WHERE id = $1", [destino_id, origen.personas]);
            await client.query("UPDATE pos_cuentas SET estado = 'UNIDA', unida_a = $2, cerrada_at = now() WHERE id = $1", [origen_id, destino_id]);
        });
        return this.obtener(empresa_id, destino_id);
    }

    // Separa renglones (o parte de su cantidad) en una cuenta nueva de la misma mesa.
    async dividir(empresa_id, cuenta_id, partes, usuario_id) {
        const nuevaId = await this.#tx(async (client) => {
            const cuenta = await this.#bloquear(client, empresa_id, cuenta_id);
            const items = (await client.query(
                "SELECT * FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado <> 'CANCELADO' ORDER BY id FOR UPDATE", [cuenta_id],
            )).rows;
            const porId = new Map(items.map((i) => [i.id, i]));
            const vistos = new Set();
            let sobrante = items.reduce((s, i) => s + i.cantidad, 0);
            for (const p of partes) {
                const item = porId.get(p.item_id);
                if (!item) throw ApiError.badRequest("Un renglón no pertenece a la cuenta o está cancelado");
                if (vistos.has(p.item_id)) throw ApiError.badRequest("Un renglón viene repetido");
                vistos.add(p.item_id);
                if (p.cantidad > item.cantidad) throw ApiError.badRequest(`No puedes mover más de ${item.cantidad} de "${item.nombre}"`);
                sobrante -= p.cantidad;
            }
            if (sobrante <= 0) throw ApiError.badRequest("Deja al menos un producto en la cuenta original");

            const folio = (await client.query(Q.FOLIO, [empresa_id])).rows[0].ultimo;
            const nueva = (await client.query(
                `INSERT INTO pos_cuentas (empresa_id, folio, tipo, mesa_id, nombre_cliente, personas, mesero_id, fecha_negocio, dividida_de)
                 VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8) RETURNING id`,
                [empresa_id, folio, cuenta.tipo, cuenta.mesa_id, cuenta.nombre_cliente, usuario_id ?? cuenta.mesero_id, await fechaNegocio(client, empresa_id), cuenta_id],
            )).rows[0];

            for (const p of partes) {
                const item = porId.get(p.item_id);
                if (p.cantidad === item.cantidad) {
                    await client.query("UPDATE pos_cuenta_items SET cuenta_id = $2 WHERE id = $1", [item.id, nueva.id]);
                    continue;
                }
                // Cantidad parcial: el descuento fijo se reparte en proporción.
                const total = aCentavos(item.descuento);
                const movido = Math.round((total * p.cantidad) / item.cantidad);
                await client.query("UPDATE pos_cuenta_items SET cantidad = cantidad - $2, descuento = $3 WHERE id = $1", [item.id, p.cantidad, (total - movido) / 100]);
                await client.query(
                    `INSERT INTO pos_cuenta_items (empresa_id, cuenta_id, receta_id, producto_id, nombre, precio_unitario, iva_pct, precio_incluye_iva,
                        cantidad, notas, estado, area_id, comanda_id, descuento, cortesia, autorizado_por, motivo, creado_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                    [empresa_id, nueva.id, item.receta_id, item.producto_id, item.nombre, item.precio_unitario, item.iva_pct, item.precio_incluye_iva,
                        p.cantidad, item.notas, item.estado, item.area_id, item.comanda_id, movido / 100, item.cortesia, item.autorizado_por, item.motivo, item.creado_por],
                );
            }
            return nueva.id;
        });
        return { origen: await this.obtener(empresa_id, cuenta_id), nueva: await this.obtener(empresa_id, nuevaId) };
    }

    async cancelarCuenta(empresa_id, cuenta_id, { motivo, autorizador_id, solicitante_id }) {
        await this.#tx(async (client) => {
            await this.#bloquear(client, empresa_id, cuenta_id);
            const enviados = (await client.query("SELECT COALESCE(SUM(precio_unitario * cantidad), 0) AS importe FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado = 'ENVIADO'", [cuenta_id])).rows[0];
            const hayEnviados = (await client.query("SELECT 1 FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado = 'ENVIADO' LIMIT 1", [cuenta_id])).rowCount > 0;
            if (hayEnviados && !autorizador_id) throw ApiError.forbidden("La cuenta ya tiene productos enviados: cancelarla requiere autorización de un supervisor");
            if (hayEnviados && !motivo) throw ApiError.badRequest("Indica el motivo de la cancelación");
            await client.query("DELETE FROM pos_cuenta_items WHERE cuenta_id = $1 AND estado = 'PENDIENTE'", [cuenta_id]);
            await client.query("UPDATE pos_cuentas SET estado = 'CANCELADA', cerrada_at = now(), motivo_cancelacion = $2 WHERE id = $1", [cuenta_id, motivo || null]);
            if (hayEnviados) {
                await registrarAutorizacion(client, { empresa_id, cuenta_id, tipo: "CANCELAR_CUENTA", monto: Number(enviados.importe), motivo, autorizado_por: autorizador_id, solicitado_por: solicitante_id });
            }
        });
        return this.obtener(empresa_id, cuenta_id);
    }

    // Cobra la cuenta en UNA transacción: pagos, descuento de inventario (referencia POS_CUENTA), cierre de la
    // cuenta (la mesa queda libre) y ticket en cola. Responde 409 si otra caja ya la cobró. El inventario nunca
    // bloquea el cobro: la venta ya ocurrió, y un stock negativo es señal de existencias desfasadas.
    async cobrar(empresa_id, cuenta_id, pagos, usuario_id) {
        const resultado = await this.#tx(async (client) => {
            const cuenta = await this.#bloquear(client, empresa_id, cuenta_id);
            const turno = (await client.query(Q.TURNO_ABIERTO, [empresa_id, usuario_id])).rows[0];
            if (!turno) throw ApiError.conflict("Abre tu caja para poder cobrar");

            const items = (await client.query(
                `SELECT ${ITEM_COLS} FROM pos_cuenta_items i LEFT JOIN areas_preparacion a ON a.id = i.area_id
                 WHERE i.cuenta_id = $1 ORDER BY i.id FOR UPDATE OF i`, [cuenta_id],
            )).rows;
            const vivos = items.filter((i) => i.estado !== "CANCELADO");
            if (vivos.length === 0) throw ApiError.badRequest("La cuenta no tiene productos que cobrar; cancélala si ya no se usará");
            const sinEnviar = vivos.filter((i) => i.estado === "PENDIENTE").reduce((s, i) => s + i.cantidad, 0);
            if (sinEnviar > 0) throw ApiError.badRequest(`Hay ${sinEnviar} producto(s) sin enviar a preparación: envíalos o quítalos antes de cobrar`);

            const totales = calcularTotales(vivos);
            const cobro = normalizarPagos(totales.total, pagos);

            const renglones = vivos.map((i) => ({ receta_id: i.receta_id, producto_id: i.producto_id, cantidad: i.cantidad }));
            const ctx = await cargarContextoConsumo(client, empresa_id, renglones);
            const inventario = await aplicarConsumo(client, this.movimientoRepository, empresa_id, {
                consumo: ctx.consumo,
                autoProduccion: ctx.autoProduccion,
                nombrePorId: ctx.nombrePorId,
                referencia_tipo: "POS_CUENTA",
                referencia_id: cuenta_id,
                usuario_id,
                motivoAuto: `Producción automática por venta POS folio ${cuenta.folio}`,
                motivoVenta: `Venta POS folio ${cuenta.folio}`,
            });

            for (const p of cobro.pagos) {
                await client.query(
                    `INSERT INTO pos_pagos (empresa_id, cuenta_id, turno_id, usuario_id, metodo, monto, propina, recibido, cambio, referencia)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                    [empresa_id, cuenta_id, turno.id, usuario_id, p.metodo, p.monto, p.propina, p.recibido, p.cambio, p.referencia],
                );
            }
            // La venta pertenece al turno y al día de negocio de quien cobra, no al de quien abrió la cuenta.
            await client.query(
                `UPDATE pos_cuentas SET estado = 'PAGADA', turno_id = $2, fecha_negocio = $3, cerrada_at = now(), cobrada_por = $4,
                        subtotal = $5, descuento = $6, iva = $7, total = $8, propina = $9 WHERE id = $1`,
                [cuenta_id, turno.id, turno.fecha_negocio, usuario_id, totales.subtotal, totales.descuento, totales.iva, totales.total, cobro.propina],
            );

            const negocio = (await client.query(Q.NEGOCIO, [empresa_id])).rows[0]?.nombre ?? "";
            const mesa = cuenta.mesa_id ? (await client.query("SELECT nombre FROM mesas WHERE id = $1", [cuenta.mesa_id])).rows[0] : null;
            const nombres = (await client.query("SELECT id, nombre FROM usuarios WHERE id = ANY($1::int[])", [[cuenta.mesero_id, usuario_id].filter(Boolean)])).rows;
            const nombreDe = (id) => nombres.find((u) => u.id === id)?.nombre ?? null;
            const payload = payloadTicket({ negocio, cuenta, mesa, mesero: nombreDe(cuenta.mesero_id), cajero: nombreDe(usuario_id), items, pagos: cobro.pagos, propina: cobro.propina, cambio: cobro.cambio });
            const impresora = (await client.query("SELECT id FROM impresoras WHERE empresa_id = $1 AND es_ticket AND activo ORDER BY id LIMIT 1", [empresa_id])).rows[0];
            const impresion = await this.#crearImpresion(client, empresa_id, { tipo: "TICKET", referencia_id: cuenta_id, payload, impresora, faltante: "tickets" });

            return {
                cambio: cobro.cambio,
                propina: cobro.propina,
                ticket: { impresion_id: impresion.id, impresion_estado: impresion.estado },
                inventario: { negativos: inventario.negativos, errores: inventario.errores, recetas_sin_escandallo: ctx.recetas_sin_escandallo.length },
            };
        });
        return { ...resultado, cuenta: await this.obtener(empresa_id, cuenta_id) };
    }

    // Último ticket generado para la cuenta (para reimprimirlo).
    async ultimoTicket(empresa_id, cuenta_id) {
        const r = await pool.query(
            "SELECT id, estado FROM pos_impresiones WHERE empresa_id = $1 AND tipo = 'TICKET' AND referencia_id = $2 ORDER BY id DESC LIMIT 1",
            [empresa_id, cuenta_id],
        );
        if (!r.rows[0]) throw ApiError.notFound("Esta cuenta no tiene ticket: solo las cuentas cobradas lo generan");
        return r.rows[0];
    }

    // Estado de cuenta para que el cliente lo revise antes de pagar. Se encola para la impresora de tickets.
    async precuenta(empresa_id, cuenta_id, usuario_id) {
        const cuenta = await this.obtener(empresa_id, cuenta_id);
        if (cuenta.estado !== "ABIERTA") throw ApiError.conflict("La cuenta ya no está abierta");
        if (!cuenta.items.some((i) => i.estado !== "CANCELADO")) throw ApiError.badRequest("La cuenta no tiene productos");
        const negocio = (await pool.query(Q.NEGOCIO, [empresa_id])).rows[0]?.nombre ?? "";
        const mesero = (await pool.query("SELECT nombre FROM usuarios WHERE id = $1", [usuario_id])).rows[0]?.nombre ?? cuenta.mesero;
        const payload = payloadPrecuenta({ negocio, cuenta, mesa: cuenta.mesa ? { nombre: cuenta.mesa } : null, mesero, items: cuenta.items });
        const impresora = (await pool.query("SELECT id FROM impresoras WHERE empresa_id = $1 AND es_ticket AND activo ORDER BY id LIMIT 1", [empresa_id])).rows[0];
        const impresion = await this.#crearImpresion(pool, empresa_id, { tipo: "PRECUENTA", referencia_id: cuenta_id, payload, impresora, faltante: "tickets" });
        return { impresion_id: impresion.id, impresion_estado: impresion.estado, payload };
    }

    // ---- Turnos de caja (apertura simple) ----
    async abrirTurno(empresa_id, usuario_id, fondo_inicial) {
        try {
            const r = await pool.query(
                `INSERT INTO pos_turnos (empresa_id, usuario_id, fecha_negocio, fondo_inicial) VALUES ($1,$2,$3,$4)
                 RETURNING id, empresa_id, usuario_id, fecha_negocio, fondo_inicial, abierto_at, estado`,
                [empresa_id, usuario_id, await hoyEmpresa(empresa_id), fondo_inicial],
            );
            return { ...r.rows[0], csv_importado: await diaImportadoCsv(pool, empresa_id, r.rows[0].fecha_negocio) };
        } catch (error) {
            if (error.code === "23505") throw ApiError.conflict("Ya tienes una caja abierta");
            throw error;
        }
    }

    async turnoActual(empresa_id, usuario_id) {
        const r = await pool.query(
            `SELECT id, empresa_id, usuario_id, fecha_negocio, fondo_inicial, abierto_at, estado FROM pos_turnos
             WHERE empresa_id = $1 AND usuario_id = $2 AND estado = 'ABIERTO'`,
            [empresa_id, usuario_id],
        );
        const turno = r.rows[0];
        // El POS avisa si ese día ya se importó el CSV (las ventas se contarían dos veces).
        return turno ? { ...turno, csv_importado: await diaImportadoCsv(pool, empresa_id, turno.fecha_negocio) } : null;
    }
}
