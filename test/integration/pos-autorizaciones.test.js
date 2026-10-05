import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: autorizaciones, descuentos y anulaciones", { skip: SKIP }, () => {
    const A = 9441;
    const B = 9442;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor;
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
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Café Cobro'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "AU-adm", { admin: true });
        tokMesero = await mkUsuario(A, "AU-mes", { rol: "mesero", email: "mes@au.test" });
        tokCajero = await mkUsuario(A, "AU-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "AU-sup", { rol: "supervisor", email: "sup@au.test" });
        await mkUsuario(B, "AU-admB", { admin: true, email: "adminb@au.test" });

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

    const sup = { email: "sup@au.test", password: PASS };
    const stock = async (productoId) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [productoId])).rows[0].stock_actual);
    const abrirCaja = (token, fondo = 500) => req("POST", api("/turnos/abrir"), { token, body: { fondo_inicial: fondo } });
    const turnoDe = async (token) => (await req("GET", api("/turnos/actual"), { token })).json.data;
    const cuenta = async (id, token = tokCajero) => (await req("GET", api(`/cuentas/${id}`), { token })).json.data;
    const descItem = (id, item, body, token = tokCajero) => req("POST", api(`/cuentas/${id}/items/${item}/descuento`), { token, body });
    const descCuenta = (id, body, token = tokCajero) => req("POST", api(`/cuentas/${id}/descuento`), { token, body });
    const anular = (id, body, token = tokCajero) => req("POST", api(`/cuentas/${id}/anular`), { token, body });
    const tipos = async () => (await pool.query("SELECT tipo, monto::float AS monto, autorizado_por, solicitado_por FROM pos_autorizaciones WHERE empresa_id = $1 ORDER BY id", [A])).rows;

    it("descuento a un renglón: sin permiso se pide un supervisor; sus credenciales autorizan y queda su nombre", async () => {
        const id = await cuentaLista([linea(latte, 2), linea(baguette)]); // 110 + 120
        const c = await cuenta(id);
        const itemLatte = c.items.find((i) => i.nombre === "Latte");

        assert.equal((await descItem(id, itemLatte.id, { tipo: "PORCENTAJE", valor: 10, motivo: "Cliente frecuente" }, tokMesero)).status, 403, "sin credenciales ni permiso");
        const cuerpo = { tipo: "PORCENTAJE", valor: 10, motivo: "Cliente frecuente" };
        for (const mala of [{ ...sup, password: "otra" }, { email: "nadie@au.test", password: PASS }, { email: "mes@au.test", password: PASS }, { email: "adminb@au.test", password: PASS }]) {
            const r = await descItem(id, itemLatte.id, { ...cuerpo, autorizacion: mala }, tokMesero);
            assert.equal(r.status, 403, JSON.stringify(mala));
        }
        // Ninguno de los intentos fallidos (ni el admin de OTRA empresa) dejó huella.
        assert.equal((await pool.query("SELECT count(*)::int n FROM pos_autorizaciones WHERE empresa_id = $1", [A])).rows[0].n, 0);

        const ok = await descItem(id, itemLatte.id, { ...cuerpo, autorizacion: sup }, tokMesero);
        assert.equal(ok.status, 200, JSON.stringify(ok.json));
        const item = ok.json.data.items.find((i) => i.id === itemLatte.id);
        assert.equal(Number(item.descuento), 11);
        assert.equal(item.autorizado_por, ids["AU-sup"]);
        assert.equal(item.motivo, "Cliente frecuente");
        assert.equal(ok.json.data.totales.total, 219);
        assert.equal(ok.json.data.totales.descuento, 11);

        const aud = await tipos();
        assert.deepEqual(aud, [{ tipo: "DESCUENTO", monto: 11, autorizado_por: ids["AU-sup"], solicitado_por: ids["AU-mes"] }]);
        est.cuentaDesc = id;
        est.itemLatte = itemLatte.id;
        est.itemBag = c.items.find((i) => i.nombre === "Baguette").id;
    });

    it("el supervisor autoriza con su propia sesión y se validan tipo, valor y motivo", async () => {
        const id = est.cuentaDesc;
        assert.equal((await descItem(id, est.itemBag, { tipo: "MONTO", valor: 20, motivo: "Detalle" }, tokSupervisor)).status, 200);
        assert.equal((await descItem(id, est.itemBag, { tipo: "MONTO", motivo: "x" }, tokSupervisor)).status, 400, "falta el valor");
        assert.equal((await descItem(id, est.itemBag, { tipo: "PORCENTAJE", valor: 101, motivo: "x" }, tokSupervisor)).status, 400);
        assert.equal((await descItem(id, est.itemBag, { tipo: "PORCENTAJE", valor: 10 }, tokSupervisor)).status, 400, "falta el motivo");
        assert.equal((await descItem(id, est.itemBag, { tipo: "MONTO", valor: 120.01, motivo: "x" }, tokSupervisor)).status, 400, "más que el renglón");
        assert.equal((await descItem(id, est.itemBag, { tipo: "MONTO", valor: 1.234, motivo: "x" }, tokSupervisor)).status, 400, "3 decimales");
        assert.equal((await descItem(id, 999999, { tipo: "CORTESIA", motivo: "x" }, tokSupervisor)).status, 404);
    });

    it("cortesía y quitar el descuento; un renglón cancelado ya no se descuenta", async () => {
        const id = est.cuentaDesc;
        const cort = await descItem(id, est.itemBag, { tipo: "CORTESIA", motivo: "Invitación de la casa" }, tokSupervisor);
        assert.equal(cort.json.data.items.find((i) => i.id === est.itemBag).cortesia, true);
        assert.equal(cort.json.data.totales.total, 99, "Latte 110 - 11; el Baguette es cortesía");
        const quita = await descItem(id, est.itemBag, { tipo: "QUITAR" }, tokSupervisor);
        const b = quita.json.data.items.find((i) => i.id === est.itemBag);
        assert.deepEqual([b.cortesia, Number(b.descuento), b.autorizado_por, b.motivo], [false, 0, null, null]);
        assert.equal(quita.json.data.totales.total, 219);

        const cancelado = await req("POST", api(`/cuentas/${id}/items/${est.itemBag}/cancelar`), { token: tokMesero, body: { motivo: "Se cayó", autorizacion: sup } });
        assert.equal(cancelado.status, 200, "el mesero cancela un renglón enviado con el supervisor");
        assert.equal((await descItem(id, est.itemBag, { tipo: "CORTESIA", motivo: "x" }, tokSupervisor)).status, 409);
        assert.equal((await req("POST", api(`/cuentas/${id}/items/${est.itemLatte}/cancelar`), { token: tokMesero, body: { motivo: "x" } })).status, 403, "sin supervisor no cancela");
    });

    it("descuento a toda la cuenta: porcentaje, monto repartido y quitar", async () => {
        const id = await cuentaLista([linea(latte), linea(baguette)]); // 55 + 120 = 175
        assert.equal((await descCuenta(id, { tipo: "PORCENTAJE", valor: 20, motivo: "Promo" })).status, 403);
        const p = await descCuenta(id, { tipo: "PORCENTAJE", valor: 20, motivo: "Promo", autorizacion: sup });
        assert.equal(p.json.data.totales.total, 140);
        const m = await descCuenta(id, { tipo: "MONTO", valor: 17.5, motivo: "Ajuste", autorizacion: sup });
        assert.equal(m.json.data.totales.descuento, 17.5, "el monto sustituye el porcentaje anterior");
        assert.equal(m.json.data.totales.total, 157.5);
        const q = await descCuenta(id, { tipo: "QUITAR" }, tokSupervisor);
        assert.equal(q.json.data.totales.total, 175);
        assert.equal((await descCuenta(id, { tipo: "MONTO", valor: 175.01, motivo: "x" }, tokSupervisor)).status, 400);
        est.cuentaCobro = id;
    });

    it("cobrar con descuento: el total es el descontado; una cortesía total se cierra sin pagos pero el inventario sí baja", async () => {
        await abrirCaja(tokCajero, 500);
        const id = est.cuentaCobro;
        await descCuenta(id, { tipo: "PORCENTAJE", valor: 10, motivo: "Promo" }, tokSupervisor); // 157.50
        assert.equal((await cobrar(id, [{ metodo: "TARJETA", monto: 175 }])).status, 400, "ya no son 175");
        assert.equal((await cobrar(id, [{ metodo: "TARJETA", monto: 157.5 }])).status, 200);
        assert.equal((await descCuenta(id, { tipo: "QUITAR" }, tokSupervisor)).status, 409, "ya cobrada");

        const gratis = await cuentaLista([linea(latte)]);
        await descCuenta(gratis, { tipo: "CORTESIA", motivo: "Cortesía del gerente" }, tokSupervisor);
        const antes = await stock(leche);
        const r = await cobrar(gratis, []);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.cuenta.estado, "PAGADA");
        assert.equal(r.json.data.cuenta.totales.total, 0);
        assert.equal(r.json.data.cuenta.pagos.length, 0);
        assert.equal(await stock(leche), antes - 1, "la cortesía se consumió");
    });

    it("cancelar una cuenta con enviados: con supervisor; todo queda en la bitácora", async () => {
        const id = await cuentaLista([linea(latte)]);
        assert.equal((await req("POST", api(`/cuentas/${id}/cancelar`), { token: tokMesero, body: { motivo: "Se fue" } })).status, 403);
        const ok = await req("POST", api(`/cuentas/${id}/cancelar`), { token: tokMesero, body: { motivo: "Se fue", autorizacion: sup } });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.data.estado, "CANCELADA");
        const aud = (await tipos()).map((a) => a.tipo);
        assert.ok(aud.includes("CANCELAR_CUENTA") && aud.includes("CANCELAR_ITEM") && aud.includes("DESCUENTO") && aud.includes("CORTESIA") && aud.includes("QUITAR_DESCUENTO"));
    });

    it("anular una cuenta cobrada: devuelve inventario, marca los pagos y el corte abierto cuadra", async () => {
        const id = await cuentaLista([linea(latte), linea(baguette)]); // 175
        assert.equal((await cobrar(id, [{ metodo: "EFECTIVO", monto: 100, recibido: 100 }, { metodo: "TARJETA", monto: 75 }])).status, 200);
        const antes = await stock(leche);
        const turno = await turnoDe(tokCajero);
        const corteAntes = (await req("GET", api(`/turnos/${turno.id}/corte`), { token: tokCajero })).json.data.corte;

        assert.equal((await anular(id, { motivo: "Cobro duplicado" }, tokMesero)).status, 403, "el mesero no cobra ni anula");
        assert.equal((await anular(id, { motivo: "Cobro duplicado" })).status, 403, "el cajero necesita un supervisor");
        assert.equal((await anular(id, { motivo: "", autorizacion: sup })).status, 400);
        const abierta = await cuentaLista([linea(latte)]);
        assert.equal((await anular(abierta, { motivo: "x", autorizacion: sup })).status, 409, "una cuenta abierta se cancela, no se anula");

        const r = await anular(id, { motivo: "Cobro duplicado", autorizacion: sup });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const c = r.json.data;
        assert.equal(c.estado, "ANULADA");
        assert.equal(c.motivo_cancelacion, "Cobro duplicado");
        assert.ok(c.pagos.every((p) => p.anulado));
        assert.equal(await stock(leche), antes + 2, "regresó lo que consumió la venta");
        const mv = (await pool.query("SELECT tipo_movimiento FROM movimientosinventario WHERE referencia_tipo = 'POS_CUENTA' AND referencia_id = $1 ORDER BY id", [id])).rows.map((m) => m.tipo_movimiento);
        assert.deepEqual(mv, ["VENTA", "DEVOLUCION"]);

        const corte = (await req("GET", api(`/turnos/${turno.id}/corte`), { token: tokCajero })).json.data;
        assert.equal(corte.corte.ventas, corteAntes.ventas - 175, "la venta anulada ya no cuenta");
        assert.equal(corte.corte.devoluciones_efectivo, 100);
        assert.equal(corte.corte.efectivo_esperado, corteAntes.efectivo_esperado - 100, "el efectivo cobrado entró y el devuelto salió: neto 0");
        assert.equal(corte.anuladas.length, 1);
        assert.ok(corte.autorizaciones.some((a) => a.tipo === "ANULAR_CUENTA" && a.motivo === "Cobro duplicado" && a.autorizado_por === "AU-sup"));

        assert.equal((await anular(id, { motivo: "otra vez", autorizacion: sup })).status, 409, "no se anula dos veces");
        assert.equal((await cobrar(id, [{ metodo: "TARJETA", monto: 175 }])).status, 409);
    });

    it("anular devuelve efectivo solo con caja abierta; sin ella se rechaza y nada cambia", async () => {
        const id = await cuentaLista([linea(latte)]);
        await cobrar(id, [{ metodo: "EFECTIVO", monto: 55 }]);
        const otroCajero = await mkUsuario(A, "AU-caj2", { rol: "cajero" });
        const antes = await stock(leche);
        const r = await anular(id, { motivo: "Error", autorizacion: sup }, otroCajero);
        assert.equal(r.status, 409);
        assert.match(r.json.error, /Abre tu caja/);
        assert.equal((await cuenta(id)).estado, "PAGADA");
        assert.equal(await stock(leche), antes);
        est.sinAnular = id;
    });

    it("anular tras cerrar el turno: el corte cerrado no cambia, los ingresos de Finanzas se ajustan y el efectivo sale del turno actual", async () => {
        // Mesas libres (las pruebas anteriores dejaron cuentas abiertas) y turno nuevo: se cierra el actual del cajero.
        await pool.query("UPDATE pos_cuentas SET estado = 'CANCELADA' WHERE empresa_id = $1 AND estado = 'ABIERTA'", [A]);
        const t0 = await turnoDe(tokCajero);
        assert.equal((await req("POST", api(`/turnos/${t0.id}/cerrar`), { token: tokCajero, body: { efectivo_contado: 0 } })).status, 200);
        assert.equal((await abrirCaja(tokCajero, 100)).status, 201);
        const t1 = await turnoDe(tokCajero);
        const s1 = await cuentaLista([linea(latte), linea(baguette)]);
        await cobrar(s1, [{ metodo: "EFECTIVO", monto: 100 }, { metodo: "TARJETA", monto: 75 }]);
        const s2 = await cuentaLista([linea(latte)]);
        await cobrar(s2, [{ metodo: "EFECTIVO", monto: 55 }]);
        const cierre = await req("POST", api(`/turnos/${t1.id}/cerrar`), { token: tokCajero, body: { efectivo_contado: 255 } });
        assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
        const cerradoAntes = (await req("GET", api(`/turnos/${t1.id}/corte`), { token: tokCajero })).json.data.corte;
        assert.equal(cerradoAntes.ventas, 230);
        assert.equal(cerradoAntes.efectivo_esperado, 255);

        assert.equal((await abrirCaja(tokCajero, 200)).status, 201);
        const t2 = await turnoDe(tokCajero);
        const r = await anular(s1, { motivo: "Cliente no pagó", autorizacion: sup });
        assert.equal(r.status, 200, JSON.stringify(r.json));

        const ing = (await pool.query("SELECT metodo_pago, monto::float AS monto, anulado FROM ingresos WHERE pos_turno_id = $1 ORDER BY metodo_pago", [t1.id])).rows;
        assert.deepEqual(ing, [{ metodo_pago: "EFECTIVO", monto: 55, anulado: false }, { metodo_pago: "TARJETA", monto: 75, anulado: true }]);

        const cerradoDespues = (await req("GET", api(`/turnos/${t1.id}/corte`), { token: tokCajero })).json.data;
        assert.deepEqual(cerradoDespues.corte.ventas, 230, "el corte cerrado se conserva tal como se cerró");
        assert.equal(cerradoDespues.corte.efectivo_esperado, 255);
        assert.deepEqual(cerradoDespues.anuladas.map((a) => a.folio), [(await cuenta(s1)).folio], "pero deja ver la anulación posterior");

        const actual = (await req("GET", api(`/turnos/${t2.id}/corte`), { token: tokCajero })).json.data.corte;
        assert.equal(actual.devoluciones_efectivo, 100);
        assert.equal(actual.efectivo_esperado, 100, "fondo 200 menos los 100 devueltos");
        assert.equal((await anular(s2, { motivo: "x", autorizacion: sup }, tokCajero)).status, 200);
        const ing2 = (await pool.query("SELECT anulado FROM ingresos WHERE pos_turno_id = $1 AND metodo_pago = 'EFECTIVO'", [t1.id])).rows;
        assert.deepEqual(ing2, [{ anulado: true }], "al llegar a 0 el ingreso se anula");
    });
});
