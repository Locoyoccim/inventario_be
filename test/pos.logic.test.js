import test from "node:test";
import assert from "node:assert/strict";
import { agruparPorArea, aplicarCorrecciones, calcularCorte, diferenciaPagos, efectivoDePagos, mismosPagos, descuentoDeRenglon, repartirDescuento, calcularTotales, diferenciaEfectivo, importeItem, normalizarPagos, payloadComanda, payloadPrecuenta, payloadTicket } from "../src/modules/pos/pos.logic.js";

const item = (extra = {}) => ({ precio_unitario: 100, cantidad: 1, iva_pct: 16, precio_incluye_iva: true, estado: "ENVIADO", descuento: 0, cortesia: false, ...extra });

test("pos: precio con IVA incluido no suma IVA y lo desglosa", () => {
    const t = calcularTotales([item({ precio_unitario: 116, cantidad: 2 })]);
    assert.equal(t.total, 232);
    assert.equal(t.iva, 32);
    assert.equal(t.subtotal, 232);
});

test("pos: precio sin IVA incluido suma el IVA encima", () => {
    const t = calcularTotales([item({ precio_incluye_iva: false, precio_unitario: 100, cantidad: 3 })]);
    assert.equal(t.iva, 48);
    assert.equal(t.total, 348);
});

test("pos: renglón cancelado no suma", () => {
    assert.deepEqual(importeItem(item({ estado: "CANCELADO" })), { base: 0, descuento: 0, iva: 0, total: 0 });
    assert.equal(calcularTotales([item(), item({ estado: "CANCELADO", precio_unitario: 999 })]).total, 100);
});

test("pos: cortesía deja el renglón en 0 y cuenta como descuento", () => {
    const t = calcularTotales([item({ precio_unitario: 85, cantidad: 2, cortesia: true }), item({ precio_unitario: 50 })]);
    assert.equal(t.total, 50);
    assert.equal(t.descuento, 170);
});

test("pos: el descuento nunca deja el renglón en negativo", () => {
    assert.equal(calcularTotales([item({ precio_unitario: 40, descuento: 100 })]).total, 0);
});

test("pos: centavos exactos, sin errores de punto flotante", () => {
    const t = calcularTotales([item({ precio_unitario: 0.1, cantidad: 3 }), item({ precio_unitario: 0.2, cantidad: 1 })]);
    assert.equal(t.total, 0.5);
});

test("pos: agrupa por área y separa 'Sin comanda' y artículos sin área", () => {
    const areas = new Map([
        [1, { id: 1, nombre: "Cocina", imprime: true }],
        [2, { id: 2, nombre: "Barra", imprime: true }],
        [3, { id: 3, nombre: "Sin comanda", imprime: false }],
    ]);
    const items = [{ id: 1, area_id: 1 }, { id: 2, area_id: 2 }, { id: 3, area_id: 1 }, { id: 4, area_id: 3 }, { id: 5, area_id: null }];
    const { comandas, sinComanda } = agruparPorArea(items, areas);
    assert.deepEqual(comandas.map((c) => [c.area.nombre, c.items.map((i) => i.id)]), [["Cocina", [1, 3]], ["Barra", [2]]]);
    assert.deepEqual(sinComanda.map((i) => i.id), [4, 5]);
});

test("pos: la comanda lleva mesa, mesero, número y notas, sin precios", () => {
    const p = payloadComanda({
        negocio: "Café Aroma", cuenta: { folio: 12, tipo: "MESA", personas: 3 }, mesa: { nombre: "Mesa 4" }, mesero: "Ana", numero: 2,
        area: { nombre: "Barra" }, items: [{ cantidad: 2, nombre: "Latte", notas: "sin azúcar", precio_unitario: 75 }],
    });
    assert.equal(p.mesa, "Mesa 4");
    assert.equal(p.comanda, 2);
    assert.deepEqual(p.items, [{ cantidad: 2, nombre: "Latte", notas: "sin azúcar" }]);
    assert.equal("precio" in p.items[0], false);
});

test("pos: el nombre de la cuenta de mesa va en comanda, precuenta y ticket; en las de llevar ya va en `llevar`", () => {
    const cuenta = { folio: 3, tipo: "MESA", personas: 4, nombre_cliente: "Fam. Hernández" };
    const base = { negocio: "Café Aroma", cuenta, mesa: { nombre: "Mesa 1" }, mesero: "Ana", items: [item({ nombre: "Latte", precio_unitario: 75 })] };
    assert.equal(payloadComanda({ ...base, numero: 1, area: { nombre: "Barra" } }).cliente, "Fam. Hernández");
    assert.equal(payloadPrecuenta(base).cliente, "Fam. Hernández");
    assert.equal(payloadTicket({ ...base, cajero: "Luis", pagos: [], propina: 0, cambio: 0 }).cliente, "Fam. Hernández");
    assert.equal(payloadPrecuenta({ ...base, cuenta: { ...cuenta, nombre_cliente: "" } }).cliente, null, "vacío = sin nombre");
    assert.equal(payloadPrecuenta({ ...base, cuenta: { ...cuenta, nombre_cliente: null } }).cliente, null);
    const llevar = payloadPrecuenta({ ...base, cuenta: { folio: 4, tipo: "LLEVAR", nombre_cliente: "Luis", personas: 1 }, mesa: null });
    assert.equal(llevar.llevar, "Luis");
    assert.equal(llevar.cliente, null);
});

test("pos: la precuenta excluye cancelados y trae totales", () => {
    const p = payloadPrecuenta({
        negocio: "Café Aroma", cuenta: { folio: 1, tipo: "LLEVAR", nombre_cliente: "Luis", personas: 1 }, mesa: null, mesero: "Ana",
        items: [item({ nombre: "Latte", precio_unitario: 75 }), item({ nombre: "Error", estado: "CANCELADO" })],
    });
    assert.equal(p.items.length, 1);
    assert.equal(p.llevar, "Luis");
    assert.equal(p.totales.total, 75);
});

const rechaza = (fn, patron) => assert.throws(fn, (e) => e.statusCode === 400 && patron.test(e.message));

test("pagos: efectivo exacto sin cambio", () => {
    const r = normalizarPagos(250, [{ metodo: "EFECTIVO", monto: 250 }]);
    assert.deepEqual(r.pagos[0], { metodo: "EFECTIVO", monto: 250, propina: 0, recibido: 250, cambio: 0, referencia: null });
    assert.equal(r.cambio, 0);
});

test("pagos: efectivo con billete calcula el cambio, propina incluida", () => {
    const r = normalizarPagos(450, [{ metodo: "EFECTIVO", monto: 450, propina: 30, recibido: 500 }]);
    assert.equal(r.pagos[0].cambio, 20);
    assert.equal(r.propina, 30);
    assert.equal(r.pagado, 450, "la propina no cuenta como pagado de la cuenta");
});

test("pagos: pago mixto efectivo + tarjeta suma el total exacto", () => {
    const r = normalizarPagos(300, [{ metodo: "TARJETA", monto: 200, referencia: " 4242 " }, { metodo: "EFECTIVO", monto: 100, recibido: 200 }]);
    assert.equal(r.cambio, 100);
    assert.equal(r.pagos[0].recibido, null);
    assert.equal(r.pagos[0].referencia, "4242");
});

test("pagos: un pago puede ser solo propina (cuenta en efectivo, propina con tarjeta)", () => {
    const r = normalizarPagos(100, [{ metodo: "EFECTIVO", monto: 100 }, { metodo: "TARJETA", monto: 0, propina: 15 }]);
    assert.equal(r.propina, 15);
    assert.equal(r.pagado, 100);
});

test("pagos: no suma errores de punto flotante (0.1 + 0.2)", () => {
    const r = normalizarPagos(0.3, [{ metodo: "TARJETA", monto: 0.1 }, { metodo: "TRANSFERENCIA", monto: 0.2 }]);
    assert.equal(r.pagado, 0.3);
});

test("pagos: faltante, exceso y efectivo insuficiente se rechazan con mensaje", () => {
    rechaza(() => normalizarPagos(100, [{ metodo: "TARJETA", monto: 99.99 }]), /Faltan 0\.01/);
    rechaza(() => normalizarPagos(100, [{ metodo: "TARJETA", monto: 120 }]), /exceden/);
    rechaza(() => normalizarPagos(100, [{ metodo: "EFECTIVO", monto: 100, propina: 10, recibido: 105 }]), /no cubre 110\.00/);
});

test("pagos: método inválido, pago vacío, sin pagos y demasiados pagos", () => {
    rechaza(() => normalizarPagos(100, [{ metodo: "CHEQUE", monto: 100 }]), /método/);
    rechaza(() => normalizarPagos(100, [{ metodo: "EFECTIVO", monto: 100 }, { metodo: "TARJETA", monto: 0 }]), /captura un importe/);
    rechaza(() => normalizarPagos(100, []), /al menos un pago/);
    rechaza(() => normalizarPagos(100, Array.from({ length: 7 }, () => ({ metodo: "TARJETA", monto: 10 }))), /Máximo 6/);
});

test("pagos: una cuenta de total 0 (cortesía) se cierra sin pagos", () => {
    assert.deepEqual(normalizarPagos(0, []), { pagos: [], propina: 0, cambio: 0, pagado: 0 });
});

test("ticket: trae pagos, cambio y abre el cajón solo si hubo efectivo", () => {
    const base = { negocio: "Café Aroma", cuenta: { folio: 5, tipo: "MESA", personas: 2 }, mesa: { nombre: "Mesa 3" }, mesero: "Ana", cajero: "Luis", items: [item({ nombre: "Latte", precio_unitario: 75 }), item({ nombre: "Error", estado: "CANCELADO" })], propina: 0 };
    const efectivo = payloadTicket({ ...base, pagos: [{ metodo: "EFECTIVO", monto: 75, propina: 0, recibido: 100, cambio: 25, referencia: null }], cambio: 25 });
    assert.equal(efectivo.tipo, "TICKET");
    assert.equal(efectivo.items.length, 1);
    assert.equal(efectivo.cambio, 25);
    assert.equal(efectivo.abrir_cajon, true);
    const tarjeta = payloadTicket({ ...base, pagos: [{ metodo: "TARJETA", monto: 75, propina: 0, recibido: null, cambio: null, referencia: null }], cambio: 0 });
    assert.equal(tarjeta.abrir_cajon, false);
});

test("corte: efectivo esperado = fondo + efectivo cobrado (con su propina) - propinas entregadas; la propina no es venta", () => {
    const c = calcularCorte({
        fondo: 500,
        filas: [
            { metodo: "EFECTIVO", cuentas: 2, monto: "300.00", propina: "20.00" },
            { metodo: "TARJETA", cuentas: 1, monto: "250.50", propina: "40.00" },
        ],
        propinas_entregadas: 30,
    });
    assert.equal(c.ventas, 550.5);
    assert.equal(c.propinas, 60);
    assert.equal(c.efectivo_cobrado, 320);
    assert.equal(c.efectivo_esperado, 790);
    assert.deepEqual(c.por_metodo.map((m) => [m.metodo, m.monto]), [["EFECTIVO", 300], ["TARJETA", 250.5], ["TRANSFERENCIA", 0]]);
});

test("corte: un turno sin ventas espera solo el fondo", () => {
    const c = calcularCorte({ fondo: 200, filas: [] });
    assert.equal(c.ventas, 0);
    assert.equal(c.efectivo_esperado, 200);
});

test("corte: la diferencia es contado - esperado, sin errores de punto flotante", () => {
    assert.equal(diferenciaEfectivo(790, 790), 0);
    assert.equal(diferenciaEfectivo(780.1, 790.3), -10.2);
    assert.equal(diferenciaEfectivo(800, 790), 10);
});

const renglon = (id, precio, cantidad, extra = {}) => ({ id, precio_unitario: precio, cantidad, estado: "ENVIADO", cortesia: false, descuento: 0, iva_pct: 16, precio_incluye_iva: true, ...extra });

test("descuento de renglón: porcentaje, monto, cortesía y quitar", () => {
    const r = renglon(1, 55, 3); // base 165
    assert.deepEqual(descuentoDeRenglon(r, { tipo: "PORCENTAJE", valor: 10 }), { descuento: 16.5, cortesia: false, importe: 16.5 });
    assert.deepEqual(descuentoDeRenglon(r, { tipo: "MONTO", valor: 20 }), { descuento: 20, cortesia: false, importe: 20 });
    assert.deepEqual(descuentoDeRenglon(r, { tipo: "CORTESIA" }), { descuento: 0, cortesia: true, importe: 165 });
    assert.deepEqual(descuentoDeRenglon(r, { tipo: "QUITAR" }), { descuento: 0, cortesia: false, importe: 0 });
    assert.equal(descuentoDeRenglon(r, { tipo: "PORCENTAJE", valor: 100 }).descuento, 165);
});

test("descuento de renglón: no pasa del importe ni del 100 %", () => {
    const r = renglon(1, 55, 1);
    rechaza(() => descuentoDeRenglon(r, { tipo: "MONTO", valor: 55.01 }), /excede/);
    rechaza(() => descuentoDeRenglon(r, { tipo: "PORCENTAJE", valor: 101 }), /entre 0 y 100/);
    rechaza(() => descuentoDeRenglon(r, { tipo: "PORCENTAJE", valor: 0 }), /entre 0 y 100/);
    rechaza(() => descuentoDeRenglon(r, { tipo: "RARO" }), /no válido/);
});

test("descuento a la cuenta: el monto se reparte en proporción y suma exactamente lo pedido", () => {
    const items = [renglon(1, 100, 1), renglon(2, 50, 1), renglon(3, 50, 1, { estado: "CANCELADO" }), renglon(4, 30, 1, { cortesia: true })];
    const r = repartirDescuento(items, { tipo: "MONTO", valor: 10 });
    assert.deepEqual(r.map((x) => x.id), [1, 2], "ni cancelados ni cortesías");
    assert.equal(r.reduce((s, x) => s + Math.round(x.descuento * 100), 0), 1000);
    assert.deepEqual(r.map((x) => x.descuento), [6.67, 3.33]);
});

test("descuento a la cuenta: los centavos sobrantes no se pierden ni exceden un renglón", () => {
    const r = repartirDescuento([renglon(1, 0.01, 1), renglon(2, 0.01, 1), renglon(3, 0.01, 1)], { tipo: "MONTO", valor: 0.02 });
    assert.equal(r.reduce((s, x) => s + Math.round(x.descuento * 100), 0), 2);
    assert.ok(r.every((x) => x.descuento <= 0.01));
    const todo = repartirDescuento([renglon(1, 10, 1), renglon(2, 5, 1)], { tipo: "MONTO", valor: 15 });
    assert.deepEqual(todo.map((x) => x.descuento), [10, 5]);
});

test("descuento a la cuenta: porcentaje, cortesía, quitar y errores", () => {
    const items = [renglon(1, 100, 2), renglon(2, 40, 1)];
    assert.deepEqual(repartirDescuento(items, { tipo: "PORCENTAJE", valor: 10 }).map((x) => x.descuento), [20, 4]);
    assert.ok(repartirDescuento(items, { tipo: "CORTESIA" }).every((x) => x.cortesia));
    assert.ok(repartirDescuento(items, { tipo: "QUITAR" }).every((x) => x.descuento === 0 && !x.cortesia));
    rechaza(() => repartirDescuento(items, { tipo: "MONTO", valor: 241 }), /excede/);
    rechaza(() => repartirDescuento([renglon(1, 10, 1, { estado: "CANCELADO" })], { tipo: "MONTO", valor: 1 }), /No hay renglones/);
});

test("corte: las anulaciones restan ventas y el efectivo devuelto sale del cajón, aunque el efectivo ya hubiera entrado", () => {
    const c = calcularCorte({
        fondo: 500,
        filas: [{ metodo: "EFECTIVO", cuentas: 1, monto: "100.00", propina: "0.00" }], // la venta de 80 en efectivo se anuló
        efectivo_ingresado: 180,
        devoluciones_efectivo: 80,
    });
    assert.equal(c.ventas, 100);
    assert.equal(c.efectivo_cobrado, 180);
    assert.equal(c.devoluciones_efectivo, 80);
    assert.equal(c.efectivo_esperado, 600, "500 + 180 - 80");
});

test("correcciones: efectivo, igualdad y diferencia entre dos juegos de pagos", () => {
    const antes = [{ metodo: "EFECTIVO", monto: 175, propina: 25, referencia: null }];
    const despues = [{ metodo: "TARJETA", monto: 100, propina: 25 }, { metodo: "TRANSFERENCIA", monto: 75, propina: 0 }];
    assert.equal(efectivoDePagos(antes), 200, "monto + propina en efectivo");
    assert.equal(efectivoDePagos(despues), 0);
    assert.equal(mismosPagos(antes, [{ metodo: "EFECTIVO", monto: "175.00", propina: 25 }]), true, "mismo reparto aunque cambie el formato");
    assert.equal(mismosPagos(despues, [...despues].reverse()), true, "el orden no importa");
    assert.equal(mismosPagos(antes, [{ metodo: "EFECTIVO", monto: 175, propina: 25, referencia: "A1" }]), false, "cambiar la referencia es una corrección");
    const d = diferenciaPagos(antes, despues);
    assert.equal(d.efectivo, -200);
    assert.deepEqual(d.por_metodo.map((m) => [m.metodo, m.cuentas, m.monto, m.propina]), [["EFECTIVO", -1, -175, -25], ["TARJETA", 1, 100, 25], ["TRANSFERENCIA", 1, 75, 0]]);
});

test("correcciones: un corte cerrado suma solo lo corregido después del cierre y recalcula la diferencia", () => {
    const corte = calcularCorte({ fondo: 500, filas: [{ metodo: "EFECTIVO", cuentas: 1, monto: 120, propina: 0 }, { metodo: "TARJETA", cuentas: 1, monto: 55, propina: 0 }] });
    assert.equal(corte.efectivo_esperado, 620);
    const pagoEf = [{ metodo: "EFECTIVO", monto: 120, propina: 0 }];
    const pagoTj = [{ metodo: "TARJETA", monto: 120, propina: 0 }];
    assert.equal(aplicarCorrecciones(corte, 500, []), null);
    assert.equal(aplicarCorrecciones(corte, 500, [{ turno_cerrado: false, antes: pagoEf, despues: pagoTj }]), null, "lo corregido con el turno abierto ya va en el cierre");
    const r = aplicarCorrecciones(corte, 500, [{ turno_cerrado: true, antes: pagoEf, despues: pagoTj }]);
    assert.equal(r.corte.efectivo_esperado, 500);
    assert.equal(r.corte.efectivo_cobrado, 0);
    assert.equal(r.diferencia, 0, "contado 500 contra esperado 500");
    assert.equal(r.corte.ventas, 175, "el total vendido no cambia");
    assert.deepEqual(r.corte.por_metodo.map((m) => [m.metodo, m.cuentas, m.monto]), [["EFECTIVO", 0, 0], ["TARJETA", 2, 175], ["TRANSFERENCIA", 0, 0]]);
    assert.equal(corte.efectivo_esperado, 620, "el corte original no se modifica");
});
