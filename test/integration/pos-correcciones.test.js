import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { iniciarServidor } from "../helpers/servidor.js";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: corrección de pagos ya cobrados", { skip: SKIP }, () => {
    const A = 9461;
    const B = 9462;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCajero;
    let mesas = [];
    let latte, baguette, leche, pelId;
    const est = {};

    const req = async (method, path, { token, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const api = (p) => `/api/pos/${A}${p}`;

    const limpiar = async () => {
        const e = [[A, B]];
        await pool.query("DELETE FROM ingresos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_autorizaciones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_devoluciones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_correcciones_pago WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_pagos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuenta_items WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_comandas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuentas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_turnos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_folios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM mesas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM areas_preparacion WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    const PASS = "Clave-Segura-1";
    const ids = {};
    const mkUsuario = async (empresa, codigo, { admin = false, rol = null, email = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id,email,password_hash) VALUES ($1,$1,$2,$2,$3,$4,$5,$6) RETURNING id",
            [codigo, admin, empresa, rolId, email, email ? await bcrypt.hash(PASS, 4) : null],
        )).rows[0].id;
        ids[codigo] = id;
        return signToken({ id, empresa_id: empresa, is_admin: admin, is_owner: admin, tv: 0 });
    };
    const linea = (a, cantidad = 1) => ({ tipo: a.tipo, id: a.id, cantidad });

    let siguienteMesa = 0;
    // Cuenta con productos ya enviados, lista para cobrar.
    const cuentaLista = async (lineas) => {
        const mesa = mesas[siguienteMesa++ % mesas.length];
        const c = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 2 } })).json.data;
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: { lineas } });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        return c.id;
    };
    const cobrar = (id, pagos, token = tokCajero) => req("POST", api(`/cuentas/${id}/cobrar`), { token, body: { pagos } });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Café Cobro'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "AU-adm", { admin: true });
        tokMesero = await mkUsuario(A, "AU-mes", { rol: "mesero", email: "mes@co.test" });
        tokCajero = await mkUsuario(A, "AU-caj", { rol: "cajero" });
        await mkUsuario(A, "AU-sup", { rol: "supervisor", email: "sup@co.test" });
        await mkUsuario(B, "AU-admB", { admin: true, email: "adminb@co.test" });

        const areas = (await req("GET", api("/areas"), { token: tokAdmin })).json.data;
        const sinComanda = areas.find((a) => a.nombre === "Sin comanda").id;
        for (let i = 1; i <= 8; i++) mesas.push((await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);

        const provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        const prod = async (b) => (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin, body: { unidad_medida: "pz", proveedor_id: provId, cantidad_presentacion: 1, costo_presentacion: 10, stock_minimo: 0, ...b },
        })).json.data.id;
        leche = await prod({ producto: "Leche", categoria: "Insumo", stock_actual: 10 });
        pelId = await prod({ producto: "Pellegrino", categoria: "Bebidas", stock_actual: 10, costo_presentacion: 20, precio_venta: 45 });
        await req("PUT", api(`/asignacion-areas/producto/${pelId}`), { token: tokAdmin, body: { area_id: sinComanda } });
        const mkReceta = async (b) => (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body: { ...b, ingredientes: [{ producto_id: leche, cantidad: 1 }] } })).json.data.id;
        latte = { tipo: "RECETA", id: await mkReceta({ nombre: "Latte", categoria: "Bebidas", precio_venta: 55 }) };
        baguette = { tipo: "RECETA", id: await mkReceta({ nombre: "Baguette", categoria: "Platillos", precio_venta: 120 }) };
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    const sup = { email: "sup@co.test", password: PASS };
    const abrirCaja = (token, fondo = 500) => req("POST", api("/turnos/abrir"), { token, body: { fondo_inicial: fondo } });
    const turnoDe = async (token) => (await req("GET", api("/turnos/actual"), { token })).json.data;
    const cuenta = async (id, token = tokCajero) => (await req("GET", api(`/cuentas/${id}`), { token })).json.data;
    const anular = (id, body, token = tokCajero) => req("POST", api(`/cuentas/${id}/anular`), { token, body });
    const tipos = async () => (await pool.query("SELECT tipo, monto::float AS monto, autorizado_por, solicitado_por FROM pos_autorizaciones WHERE empresa_id = $1 ORDER BY id", [A])).rows;

    const corregir = (id, body, token = tokCajero) => req("POST", api(`/cuentas/${id}/corregir-pago`), { token, body });
    const corteDe = async (turno, token = tokCajero) => (await req("GET", api(`/turnos/${turno}/corte`), { token })).json.data;
    const ingresosTurno = async (t) => (await pool.query("SELECT metodo_pago, monto::float AS monto, anulado FROM ingresos WHERE pos_turno_id = $1 ORDER BY id", [t])).rows;
    const MOTIVO = "Se capturó mal el método";

    it("turno abierto: se corrige el método, el corte se recalcula y quedan la bitácora y el ticket", async () => {
        assert.equal((await abrirCaja(tokCajero, 500)).status, 201);
        const t = (await turnoDe(tokCajero)).id;
        est.turno = t;
        est.c1 = await cuentaLista([linea(latte), linea(baguette)]);
        assert.equal((await cobrar(est.c1, [{ metodo: "EFECTIVO", monto: 175, propina: 25, recibido: 200 }])).status, 200);
        est.c2 = await cuentaLista([linea(latte)]);
        assert.equal((await cobrar(est.c2, [{ metodo: "TARJETA", monto: 55 }])).status, 200);
        assert.equal((await corteDe(t)).corte.efectivo_esperado, 700, "fondo 500 + 175 + 25");

        // Validaciones: mismas reglas que al cobrar, y nada se guarda si algo falla.
        const nuevo = [{ metodo: "TARJETA", monto: 175, propina: 25 }];
        assert.equal((await corregir(est.c1, { pagos: [{ metodo: "TARJETA", monto: 100, propina: 25 }], motivo: MOTIVO, autorizacion: sup })).status, 400, "no suma el total");
        assert.equal((await corregir(est.c1, { pagos: [{ metodo: "EFECTIVO", monto: 175, propina: 25 }], motivo: MOTIVO, autorizacion: sup })).status, 400, "sin cambios");
        assert.equal((await corregir(est.c1, { pagos: nuevo, motivo: "", autorizacion: sup })).status, 400, "sin motivo");
        assert.equal((await corregir(est.c1, { pagos: nuevo, motivo: MOTIVO })).status, 403, "el cajero necesita un supervisor");
        assert.equal((await corregir(est.c1, { pagos: nuevo, motivo: MOTIVO, autorizacion: { ...sup, password: "mal" } })).status, 403);
        assert.equal((await corregir(est.c1, { pagos: nuevo, motivo: MOTIVO, autorizacion: sup }, tokMesero)).status, 403, "el mesero no cobra");
        const abierta = await cuentaLista([linea(latte)]);
        assert.equal((await corregir(abierta, { pagos: nuevo, motivo: MOTIVO, autorizacion: sup })).status, 409, "una cuenta abierta no se corrige");
        assert.equal((await cuenta(est.c1)).pagos[0].metodo, "EFECTIVO", "nada cambió");
        await req("POST", api(`/cuentas/${abierta}/cancelar`), { token: tokMesero, body: { motivo: "x", autorizacion: sup } });

        const r = await corregir(est.c1, { pagos: nuevo, motivo: MOTIVO, autorizacion: sup });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const c = r.json.data;
        assert.deepEqual(c.pagos.map((p) => [p.metodo, Number(p.monto), Number(p.propina), p.anulado]), [["TARJETA", 175, 25, false]]);
        assert.equal(Number(c.propina), 25);
        assert.equal(c.turno_cerrado, false);
        assert.equal(c.correcciones.length, 1);
        assert.equal(c.correcciones[0].motivo, MOTIVO);
        assert.equal(c.correcciones[0].autorizado_por, "AU-sup");

        const corte = await corteDe(t);
        assert.equal(corte.corte.efectivo_esperado, 500, "ya no entró efectivo");
        assert.deepEqual(corte.corte.por_metodo.map((m) => [m.metodo, m.cuentas, m.monto, m.propina]), [["EFECTIVO", 0, 0, 0], ["TARJETA", 2, 230, 25], ["TRANSFERENCIA", 0, 0, 0]]);
        assert.equal(corte.correcciones.length, 1);
        assert.equal(corte.correcciones[0].turno_cerrado, false);
        assert.equal(corte.ajustado, null, "con el turno abierto el corte ya es el vigente");

        const ticket = (await pool.query("SELECT payload FROM pos_impresiones WHERE tipo = 'TICKET' AND referencia_id = $1", [est.c1])).rows[0].payload;
        assert.deepEqual(ticket.pagos.map((p) => p.metodo), ["TARJETA"]);
        assert.equal(ticket.corregido, true);
        assert.equal(ticket.abrir_cajon, false);
        const log = (await tipos()).filter((x) => x.tipo === "CORREGIR_PAGO");
        assert.equal(log.length, 1);
        assert.equal(log[0].autorizado_por, ids["AU-sup"]);
        assert.equal(log[0].solicitado_por, ids["AU-caj"]);
    });

    it("turno cerrado: el cierre original no cambia; la corrección ajusta Finanzas y la diferencia aparte", async () => {
        const t = est.turno;
        // Esta cuenta se pagó con tarjeta pero se capturó en efectivo: al contar el cajón faltan $120.
        est.c3 = await cuentaLista([linea(baguette)]);
        assert.equal((await cobrar(est.c3, [{ metodo: "EFECTIVO", monto: 120, recibido: 120 }])).status, 200);
        est.c4 = await cuentaLista([linea(latte)]);
        assert.equal((await cobrar(est.c4, [{ metodo: "TARJETA", monto: 55 }])).status, 200);
        const cierre = await req("POST", api(`/turnos/${t}/cerrar`), { token: tokCajero, body: { efectivo_contado: 500 } });
        assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
        assert.equal(Number(cierre.json.data.turno.diferencia), -120);
        assert.deepEqual(await ingresosTurno(t), [{ metodo_pago: "EFECTIVO", monto: 120, anulado: false }, { metodo_pago: "TARJETA", monto: 285, anulado: false }]);

        const r = await corregir(est.c3, { pagos: [{ metodo: "TARJETA", monto: 120 }], motivo: "Pagó con tarjeta", autorizacion: sup });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.turno_cerrado, true);

        // Finanzas: el ingreso en efectivo se anula y la tarjeta sube; el total de ventas sigue igual.
        const ing = await ingresosTurno(t);
        assert.deepEqual(ing.filter((i) => !i.anulado).map((i) => [i.metodo_pago, i.monto]), [["TARJETA", 405]]);
        assert.equal(ing.find((i) => i.metodo_pago === "EFECTIVO").anulado, true);

        const corte = await corteDe(t);
        assert.equal(corte.corte.efectivo_esperado, 620, "el cierre original no se toca");
        assert.equal(Number(corte.turno.diferencia), -120);
        assert.equal(corte.correcciones.length, 2);
        assert.deepEqual(corte.correcciones.map((c) => c.turno_cerrado), [false, true]);
        assert.equal(corte.ajustado.corte.efectivo_esperado, 500);
        assert.equal(corte.ajustado.diferencia, 0, "con la corrección el cajón sí cuadra");
        assert.deepEqual(corte.ajustado.corte.por_metodo.map((m) => [m.metodo, m.cuentas, m.monto]), [["EFECTIVO", 0, 0], ["TARJETA", 4, 405], ["TRANSFERENCIA", 0, 0]]);
        assert.equal(corte.ajustado.corte.ventas, 405);

        // Un monto mal capturado: 175 en tarjeta eran 100 en tarjeta y 75 en transferencia (aparece un ingreso nuevo).
        const mixto = await corregir(est.c1, { pagos: [{ metodo: "TARJETA", monto: 100, propina: 25 }, { metodo: "TRANSFERENCIA", monto: 75 }], motivo: "Pago dividido", autorizacion: sup });
        assert.equal(mixto.status, 200, JSON.stringify(mixto.json));
        assert.deepEqual((await ingresosTurno(t)).filter((i) => !i.anulado).map((i) => [i.metodo_pago, i.monto]), [["TARJETA", 330], ["TRANSFERENCIA", 75]]);
        assert.equal((await corteDe(t)).ajustado.corte.por_metodo.find((m) => m.metodo === "TRANSFERENCIA").monto, 75);

        // El historial de turnos trae la diferencia ya ajustada (la del cierre sigue en `diferencia`).
        const fila = (await req("GET", api("/turnos"), { token: tokCajero })).json.data.find((x) => x.id === t);
        assert.equal(Number(fila.diferencia), -120);
        assert.equal(fila.diferencia_ajustada, 0);
        assert.equal(fila.correcciones_posteriores, 2);
        assert.equal((await req("GET", api("/turnos"), { token: tokCajero })).json.data.find((x) => x.estado === "ABIERTO")?.diferencia_ajustada ?? null, null);

        // Reimprimir el corte sale ya ajustado y aclara cómo se había cerrado.
        const impresion = await req("POST", api(`/turnos/${t}/corte/imprimir`), { token: tokCajero });
        assert.equal(impresion.status, 201, JSON.stringify(impresion.json));
        const payload = (await pool.query("SELECT payload FROM pos_impresiones WHERE id = $1", [impresion.json.data.impresion_id])).rows[0].payload;
        assert.equal(payload.efectivo_esperado, 500);
        assert.equal(payload.diferencia, 0);
        assert.deepEqual(payload.ajuste, { correcciones: 2, esperado_original: 620, diferencia_original: -120 });
        assert.equal(payload.por_metodo.find((m) => m.metodo === "TARJETA").monto, 330);

        // Y si después se anula esa venta, Finanzas descuenta lo que quedó tras la corrección.
        const anulada = await anular(est.c1, { motivo: "Cliente se retiró", autorizacion: sup });
        assert.equal(anulada.status, 200, JSON.stringify(anulada.json));
        const final = (await ingresosTurno(t)).filter((i) => !i.anulado).map((i) => [i.metodo_pago, i.monto]);
        assert.deepEqual(final, [["TARJETA", 230]]);
        assert.equal((await corregir(est.c1, { pagos: [{ metodo: "EFECTIVO", monto: 175, propina: 25 }], motivo: MOTIVO, autorizacion: sup })).status, 409, "una venta anulada ya no se corrige");
    });

    it("aislamiento: otra empresa no ve ni corrige las cuentas", async () => {
        const otro = await req("POST", `/api/pos/${B}/cuentas/${est.c3}/corregir-pago`, { token: await mkUsuario(B, "AU-admB2", { admin: true }), body: { pagos: [{ metodo: "EFECTIVO", monto: 120 }], motivo: "x" } });
        assert.ok([403, 404].includes(otro.status));
    });
});
