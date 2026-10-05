// Lógica pura del POS (sin BD): totales de cuenta, validación de pagos y contenido de lo que se imprime.
import ApiError from "../../utils/ApiError.js";

const aCentavos = (n) => Math.round(Number(n) * 100);
const aPesos = (c) => c / 100;

// Importe de un renglón en centavos. Un renglón cancelado no suma. La cortesía cubre todo el
// renglón; el descuento es un monto fijo y nunca baja de 0. Si el precio no incluye IVA, el IVA
// se suma encima.
export function importeItem(item) {
    if (item.estado === "CANCELADO") return { base: 0, descuento: 0, iva: 0, total: 0 };
    const base = aCentavos(item.precio_unitario) * Number(item.cantidad);
    const descuento = item.cortesia ? base : Math.min(aCentavos(item.descuento ?? 0), base);
    const neto = base - descuento;
    const tasa = Number(item.iva_pct ?? 0) / 100;
    if (item.precio_incluye_iva === false) {
        const iva = Math.round(neto * tasa);
        return { base, descuento, iva, total: neto + iva };
    }
    return { base, descuento, iva: Math.round(neto - neto / (1 + tasa)), total: neto };
}

export function calcularTotales(items) {
    const t = { base: 0, descuento: 0, iva: 0, total: 0 };
    for (const item of items) {
        const i = importeItem(item);
        t.base += i.base;
        t.descuento += i.descuento;
        t.iva += i.iva;
        t.total += i.total;
    }
    return { subtotal: aPesos(t.base), descuento: aPesos(t.descuento), iva: aPesos(t.iva), total: aPesos(t.total) };
}

const baseRenglon = (item) => aCentavos(item.precio_unitario) * Number(item.cantidad);

// Descuento de UN renglón. PORCENTAJE (0-100] y MONTO (fijo, sin pasar del importe del renglón) dan un
// descuento; CORTESIA lo cubre todo; QUITAR lo deshace. Devuelve lo que se guarda y el importe descontado.
export function descuentoDeRenglon(item, { tipo, valor }) {
    const base = baseRenglon(item);
    if (tipo === "CORTESIA") return { descuento: 0, cortesia: true, importe: aPesos(base) };
    if (tipo === "QUITAR") return { descuento: 0, cortesia: false, importe: 0 };
    let d;
    if (tipo === "PORCENTAJE") {
        if (!(valor > 0 && valor <= 100)) throw ApiError.badRequest("El porcentaje debe estar entre 0 y 100");
        d = Math.round((base * valor) / 100);
    } else if (tipo === "MONTO") {
        d = aCentavos(valor);
        if (d <= 0) throw ApiError.badRequest("Captura el monto del descuento");
        if (d > base) throw ApiError.badRequest(`El descuento (${aPesos(d).toFixed(2)}) excede el importe del renglón (${aPesos(base).toFixed(2)})`);
    } else throw ApiError.badRequest("Tipo de descuento no válido");
    return { descuento: aPesos(d), cortesia: false, importe: aPesos(d) };
}

// Descuento a TODA la cuenta: un porcentaje de cada renglón o un monto fijo repartido en proporción a su
// importe (los centavos sobrantes se reparten renglón por renglón). Las cortesías no cambian.
export function repartirDescuento(items, { tipo, valor }) {
    const lineas = items.filter((i) => i.estado !== "CANCELADO" && !i.cortesia).map((i) => ({ id: i.id, base: baseRenglon(i) })).filter((l) => l.base > 0);
    if (lineas.length === 0) throw ApiError.badRequest("No hay renglones a los que aplicar el descuento");
    if (tipo === "QUITAR") return lineas.map((l) => ({ id: l.id, descuento: 0, cortesia: false }));
    if (tipo === "CORTESIA") return lineas.map((l) => ({ id: l.id, descuento: 0, cortesia: true }));
    if (tipo === "PORCENTAJE") {
        if (!(valor > 0 && valor <= 100)) throw ApiError.badRequest("El porcentaje debe estar entre 0 y 100");
        return lineas.map((l) => ({ id: l.id, descuento: aPesos(Math.round((l.base * valor) / 100)), cortesia: false }));
    }
    if (tipo !== "MONTO") throw ApiError.badRequest("Tipo de descuento no válido");
    const totalC = aCentavos(valor);
    const suma = lineas.reduce((s, l) => s + l.base, 0);
    if (totalC <= 0) throw ApiError.badRequest("Captura el monto del descuento");
    if (totalC > suma) throw ApiError.badRequest(`El descuento (${aPesos(totalC).toFixed(2)}) excede el total de la cuenta (${aPesos(suma).toFixed(2)})`);
    const partes = lineas.map((l) => ({ ...l, d: Math.floor((totalC * l.base) / suma) }));
    let resto = totalC - partes.reduce((s, p) => s + p.d, 0);
    for (const p of partes) {
        if (resto === 0) break;
        if (p.d < p.base) {
            p.d += 1;
            resto -= 1;
        }
    }
    return partes.map((p) => ({ id: p.id, descuento: aPesos(p.d), cortesia: false }));
}

export const METODOS_PAGO = ["EFECTIVO", "TARJETA", "TRANSFERENCIA"];
const MAX_PAGOS = 6;

// Valida y normaliza los pagos de una cuenta. La suma de `monto` debe igualar el total exacto
// (la propina va aparte y el cambio solo existe en efectivo). Una cuenta de total 0 (todo cortesía)
// se cierra sin pagos. Un pago puede traer solo propina (monto 0), p. ej. cuenta en efectivo y propina
// con tarjeta. Devuelve los pagos listos para guardar, en pesos, con cambio calculado.
export function normalizarPagos(total, pagos = []) {
    const totalC = aCentavos(total);
    if (pagos.length > MAX_PAGOS) throw ApiError.badRequest(`Máximo ${MAX_PAGOS} pagos por cuenta`);
    if (totalC === 0 && pagos.length === 0) return { pagos: [], propina: 0, cambio: 0, pagado: 0 };
    if (pagos.length === 0) throw ApiError.badRequest("Agrega al menos un pago");

    let suma = 0;
    let propinaC = 0;
    let cambioC = 0;
    const normalizados = pagos.map((p, i) => {
        const n = i + 1;
        if (!METODOS_PAGO.includes(p.metodo)) throw ApiError.badRequest(`Pago ${n}: método de pago no válido`);
        const montoC = aCentavos(p.monto ?? 0);
        const propC = aCentavos(p.propina ?? 0);
        if (montoC < 0 || propC < 0) throw ApiError.badRequest(`Pago ${n}: los importes no pueden ser negativos`);
        if (montoC + propC === 0) throw ApiError.badRequest(`Pago ${n}: captura un importe`);
        suma += montoC;
        propinaC += propC;

        let recibidoC = null;
        let pagoCambioC = null;
        if (p.metodo === "EFECTIVO") {
            const debido = montoC + propC;
            recibidoC = p.recibido === undefined || p.recibido === null ? debido : aCentavos(p.recibido);
            if (recibidoC < debido) throw ApiError.badRequest(`Pago ${n}: el efectivo recibido no cubre ${aPesos(debido).toFixed(2)}`);
            pagoCambioC = recibidoC - debido;
            cambioC += pagoCambioC;
        }
        return {
            metodo: p.metodo,
            monto: aPesos(montoC),
            propina: aPesos(propC),
            recibido: recibidoC === null ? null : aPesos(recibidoC),
            cambio: pagoCambioC === null ? null : aPesos(pagoCambioC),
            referencia: p.referencia ? String(p.referencia).trim().slice(0, 40) || null : null,
        };
    });

    if (suma < totalC) throw ApiError.badRequest(`Faltan ${aPesos(totalC - suma).toFixed(2)} por cobrar`);
    if (suma > totalC) throw ApiError.badRequest(`Los pagos exceden el total por ${aPesos(suma - totalC).toFixed(2)}; el exceso en efectivo se captura como efectivo recibido`);
    return { pagos: normalizados, propina: aPesos(propinaC), cambio: aPesos(cambioC), pagado: aPesos(suma) };
}

// Totales de un turno a partir de los pagos vigentes agrupados por método (monto, propina, cuentas). La propina
// no es venta. El efectivo en el cajón es el fondo + lo cobrado en efectivo (monto + propina; el cambio ya
// salió) - el efectivo devuelto por anulaciones - las propinas que se entregaron al personal en efectivo.
export function calcularCorte({ fondo = 0, filas = [], propinas_entregadas = 0, efectivo_ingresado, devoluciones_efectivo = 0 }) {
    const por = new Map(filas.map((f) => [f.metodo, f]));
    const por_metodo = METODOS_PAGO.map((metodo) => {
        const f = por.get(metodo);
        return { metodo, cuentas: Number(f?.cuentas ?? 0), monto: aPesos(aCentavos(f?.monto ?? 0)), propina: aPesos(aCentavos(f?.propina ?? 0)) };
    });
    const sum = (campo) => por_metodo.reduce((s, m) => s + aCentavos(m[campo]), 0);
    const efectivo = por_metodo.find((m) => m.metodo === "EFECTIVO");
    // Lo que entró al cajón: por defecto las ventas en efectivo; con anulaciones se pasa lo realmente cobrado.
    const efectivoCobradoC = efectivo_ingresado === undefined ? aCentavos(efectivo.monto) + aCentavos(efectivo.propina) : aCentavos(efectivo_ingresado);
    const devolucionesC = aCentavos(devoluciones_efectivo);
    const entregadasC = aCentavos(propinas_entregadas);
    return {
        por_metodo,
        ventas: aPesos(sum("monto")),
        propinas: aPesos(sum("propina")),
        efectivo_cobrado: aPesos(efectivoCobradoC),
        devoluciones_efectivo: aPesos(devolucionesC),
        propinas_entregadas: aPesos(entregadasC),
        efectivo_esperado: aPesos(aCentavos(fondo) + efectivoCobradoC - devolucionesC - entregadasC),
    };
}

// --- Corrección de pagos ya cobrados ---------------------------------------------------------------------------

// Lo que entra al cajón por una lista de pagos: monto + propina en efectivo (el cambio ya salió).
export const efectivoDePagos = (pagos) =>
    aPesos(pagos.filter((p) => p.metodo === "EFECTIVO").reduce((s, p) => s + aCentavos(p.monto) + aCentavos(p.propina), 0));

// Mismo reparto de métodos, montos, propinas y referencias (sin importar el orden): no hay nada que corregir.
const firma = (pagos) =>
    pagos.map((p) => `${p.metodo}|${aCentavos(p.monto)}|${aCentavos(p.propina)}|${p.referencia ?? ""}`).sort().join(";");
export const mismosPagos = (a, b) => firma(a) === firma(b);

// Cuánto cambió cada método (en pesos), cuántas cuentas pasan de uno a otro y cuánto efectivo entra de más o de menos.
export function diferenciaPagos(antes, despues) {
    const suma = (pagos, metodo, campo) => pagos.filter((p) => p.metodo === metodo).reduce((s, p) => s + aCentavos(p[campo]), 0);
    return {
        por_metodo: METODOS_PAGO.map((metodo) => ({
            metodo,
            cuentas: (despues.some((p) => p.metodo === metodo) ? 1 : 0) - (antes.some((p) => p.metodo === metodo) ? 1 : 0),
            monto: aPesos(suma(despues, metodo, "monto") - suma(antes, metodo, "monto")),
            propina: aPesos(suma(despues, metodo, "propina") - suma(antes, metodo, "propina")),
        })),
        efectivo: aPesos(aCentavos(efectivoDePagos(despues)) - aCentavos(efectivoDePagos(antes))),
    };
}

// Un corte ya cerrado conserva sus cifras de cierre. Las correcciones hechas DESPUÉS del cierre (`turno_cerrado`)
// se suman aparte para ver cómo quedó de verdad: ventas por método, efectivo esperado y diferencia contra lo contado.
// Devuelve null si no hubo ninguna.
export function aplicarCorrecciones(corte, contado, correcciones) {
    const posteriores = correcciones.filter((c) => c.turno_cerrado);
    if (posteriores.length === 0) return null;
    const por = new Map(corte.por_metodo.map((m) => [m.metodo, { ...m }]));
    let efectivoC = 0;
    for (const c of posteriores) {
        const d = diferenciaPagos(c.antes, c.despues);
        for (const m of d.por_metodo) {
            const x = por.get(m.metodo);
            x.cuentas += m.cuentas;
            x.monto = aPesos(aCentavos(x.monto) + aCentavos(m.monto));
            x.propina = aPesos(aCentavos(x.propina) + aCentavos(m.propina));
        }
        efectivoC += aCentavos(d.efectivo);
    }
    const por_metodo = METODOS_PAGO.map((m) => por.get(m));
    const sum = (campo) => por_metodo.reduce((s, m) => s + aCentavos(m[campo]), 0);
    const ajustado = {
        ...corte,
        por_metodo,
        ventas: aPesos(sum("monto")),
        propinas: aPesos(sum("propina")),
        efectivo_cobrado: aPesos(aCentavos(corte.efectivo_cobrado) + efectivoC),
        efectivo_esperado: aPesos(aCentavos(corte.efectivo_esperado) + efectivoC),
    };
    return { corte: ajustado, diferencia: contado === null || contado === undefined ? null : diferenciaEfectivo(contado, ajustado.efectivo_esperado) };
}

export const diferenciaEfectivo = (contado, esperado) => aPesos(aCentavos(contado) - aCentavos(esperado));

// `ajuste`: un corte cerrado reimpreso con correcciones de pago posteriores al cierre (cifras ya ajustadas + cómo cerró).
export function payloadCorte({ negocio, turno, cajero, corte, contado = null, diferencia = null, nota = null, ajuste = null, ahora = new Date() }) {
    return {
        tipo: "CORTE",
        negocio,
        turno: turno.id,
        cajero,
        fecha_negocio: turno.fecha_negocio,
        abierto_at: new Date(turno.abierto_at).toISOString(),
        cerrado_at: turno.cerrado_at ? new Date(turno.cerrado_at).toISOString() : null,
        impreso_at: ahora.toISOString(),
        fondo: Number(turno.fondo_inicial),
        por_metodo: corte.por_metodo,
        ventas: corte.ventas,
        propinas: corte.propinas,
        propinas_entregadas: corte.propinas_entregadas,
        devoluciones_efectivo: corte.devoluciones_efectivo ?? 0,
        efectivo_esperado: corte.efectivo_esperado,
        contado,
        diferencia,
        nota,
        ajuste,
    };
}

// Agrupa renglones PENDIENTES por área. Las áreas que no imprimen ("Sin comanda") se separan:
// esos renglones pasan a ENVIADO sin generar comanda.
export function agruparPorArea(items, areasPorId) {
    const imprimen = new Map();
    const sinComanda = [];
    for (const item of items) {
        const area = areasPorId.get(item.area_id);
        // Hay comanda si el área imprime o muestra pantalla (la pantalla solo cuenta si la empresa la tiene activada).
        if (!area || !(area.imprime || area.pantalla)) {
            sinComanda.push(item);
            continue;
        }
        if (!imprimen.has(area.id)) imprimen.set(area.id, { area, items: [] });
        imprimen.get(area.id).items.push(item);
    }
    return { comandas: [...imprimen.values()], sinComanda };
}

// Cada renglón impreso lleva sus opciones elegidas («Medio», «Extra queso»); en la comanda también el comensal al que se le sirve.
const lineaItem = (i) => ({ cantidad: Number(i.cantidad), nombre: i.nombre, notas: i.notas ?? null, opciones: (i.opciones ?? []).map((o) => o.nombre) });

export function payloadComanda({ negocio, cuenta, mesa, mesero, numero, area, items, tiempo = 1, ahora = new Date() }) {
    return {
        tipo: "COMANDA",
        negocio,
        area: area.nombre,
        folio: cuenta.folio,
        comanda: numero,
        mesa: mesa?.nombre ?? null,
        llevar: cuenta.tipo === "LLEVAR" ? (cuenta.nombre_cliente ?? "Para llevar") : null,
        // Nombre o referencia de una cuenta de mesa ("Fam. Hernández"); en las de llevar ya va en `llevar`.
        cliente: cuenta.tipo === "MESA" ? (cuenta.nombre_cliente || null) : null,
        personas: cuenta.personas,
        mesero: mesero ?? null,
        fecha: ahora.toISOString(),
        // 1 = sale ahora; 2.º y siguientes se disparan después (la comanda lo anuncia en grande).
        tiempo,
        items: items.map((i) => ({ ...lineaItem(i), comensal: i.comensal ?? null })),
    };
}

export function payloadPrecuenta({ negocio, cuenta, mesa, mesero, items, ahora = new Date() }) {
    const vivos = items.filter((i) => i.estado !== "CANCELADO");
    return {
        tipo: "PRECUENTA",
        negocio,
        folio: cuenta.folio,
        mesa: mesa?.nombre ?? null,
        llevar: cuenta.tipo === "LLEVAR" ? (cuenta.nombre_cliente ?? "Para llevar") : null,
        // Nombre o referencia de una cuenta de mesa ("Fam. Hernández"); en las de llevar ya va en `llevar`.
        cliente: cuenta.tipo === "MESA" ? (cuenta.nombre_cliente || null) : null,
        personas: cuenta.personas,
        mesero: mesero ?? null,
        fecha: ahora.toISOString(),
        items: vivos.map((i) => ({ ...lineaItem(i), precio: Number(i.precio_unitario), importe: aPesos(importeItem(i).total), cortesia: Boolean(i.cortesia) })),
        totales: calcularTotales(vivos),
    };
}

// Ticket de venta. `abrir_cajon` solo si hubo efectivo; el agente no lo repite en una reimpresión.
export function payloadTicket({ negocio, cuenta, mesa, mesero, cajero, items, pagos, propina, cambio, ahora = new Date() }) {
    const vivos = items.filter((i) => i.estado !== "CANCELADO");
    const totales = calcularTotales(vivos);
    return {
        tipo: "TICKET",
        negocio,
        folio: cuenta.folio,
        mesa: mesa?.nombre ?? null,
        llevar: cuenta.tipo === "LLEVAR" ? (cuenta.nombre_cliente ?? "Para llevar") : null,
        // Nombre o referencia de una cuenta de mesa ("Fam. Hernández"); en las de llevar ya va en `llevar`.
        cliente: cuenta.tipo === "MESA" ? (cuenta.nombre_cliente || null) : null,
        personas: cuenta.personas,
        mesero: mesero ?? null,
        cajero: cajero ?? null,
        fecha: ahora.toISOString(),
        items: vivos.map((i) => ({ ...lineaItem(i), precio: Number(i.precio_unitario), importe: aPesos(importeItem(i).total), cortesia: Boolean(i.cortesia) })),
        totales,
        pagos: pagos.map((p) => ({ metodo: p.metodo, monto: p.monto, propina: p.propina, recibido: p.recibido, cambio: p.cambio, referencia: p.referencia })),
        propina,
        cambio,
        abrir_cajon: pagos.some((p) => p.metodo === "EFECTIVO"),
    };
}

export function payloadPrueba({ negocio, impresora, ahora = new Date() }) {
    return { tipo: "PRUEBA", negocio, impresora: impresora.nombre, fecha: ahora.toISOString() };
}
