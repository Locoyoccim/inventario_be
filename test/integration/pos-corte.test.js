import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: turnos, corte de caja e ingresos", { skip: SKIP }, () => {
    const A = 9431;
    const B = 9432;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor, tokAdminB;
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

    const mkUsuario = async (empresa, codigo, { admin = false, rol = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id",
            [codigo, admin, empresa, rolId],
        )).rows[0].id;
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
        tokAdmin = await mkUsuario(A, "CT-adm", { admin: true });
        tokMesero = await mkUsuario(A, "CT-mes", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "CT-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "CT-sup", { rol: "supervisor" });
        tokAdminB = await mkUsuario(B, "CT-admB", { admin: true });

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

    const abrirCaja = (token, fondo = 500) => req("POST", api("/turnos/abrir"), { token, body: { fondo_inicial: fondo } });
    const turnoDe = async (token) => (await req("GET", api("/turnos/actual"), { token })).json.data;
    const cerrar = (id, body, token = tokCajero) => req("POST", api(`/turnos/${id}/cerrar`), { token, body });

    it("corte parcial: separa ventas de propinas y calcula el efectivo esperado; solo el dueño del turno o un supervisor lo ven", async () => {
        assert.equal((await abrirCaja(tokCajero, 500)).status, 201);
        const t = await turnoDe(tokCajero);
        est.turno = t.id;
        const c1 = await cuentaLista([linea(latte), linea(baguette)]);
        assert.equal((await cobrar(c1, [{ metodo: "EFECTIVO", monto: 175, propina: 25, recibido: 200 }])).status, 200);
        const c2 = await cuentaLista([linea(latte)]);
        assert.equal((await cobrar(c2, [{ metodo: "TARJETA", monto: 55, propina: 10 }])).status, 200);
        const c3 = await cuentaLista([linea(baguette)]);
        assert.equal((await cobrar(c3, [{ metodo: "TRANSFERENCIA", monto: 120 }])).status, 200);

        const r = await req("GET", api(`/turnos/${t.id}/corte`), { token: tokCajero });
        assert.equal(r.status, 200);
        const { corte, ventas, turno } = r.json.data;
        assert.equal(turno.estado, "ABIERTO");
        assert.equal(corte.ventas, 350);
        assert.equal(corte.propinas, 35);
        assert.equal(corte.efectivo_cobrado, 200, "efectivo + su propina; el cambio ya salió del cajón");
        assert.equal(corte.efectivo_esperado, 700, "fondo 500 + 200");
        assert.deepEqual(corte.por_metodo.map((m) => [m.metodo, m.monto, m.propina]), [["EFECTIVO", 175, 25], ["TARJETA", 55, 10], ["TRANSFERENCIA", 120, 0]]);
        assert.equal(ventas.length, 3);
        assert.deepEqual(ventas.map((v) => v.metodos), ["EFECTIVO", "TARJETA", "TRANSFERENCIA"]);

        assert.equal((await req("GET", api(`/turnos/${t.id}/corte`), { token: tokMesero })).status, 403, "el mesero no tiene acceso a la caja");
        const otro = await mkUsuario(A, "CT-caj2", { rol: "cajero" });
        assert.equal((await req("GET", api(`/turnos/${t.id}/corte`), { token: otro })).status, 403, "otro cajero no ve el turno ajeno");
        assert.equal((await req("GET", api(`/turnos/${t.id}/corte`), { token: tokSupervisor })).status, 200);
        assert.equal((await req("GET", api(`/turnos/${t.id}/corte`), { token: tokAdminB })).status, 403, "otra empresa tampoco");
    });

    it("cerrar: valida entregas, exige confirmar si quedan cuentas abiertas y no deja cerrar dos veces", async () => {
        const id = est.turno;
        assert.equal((await cerrar(id, { efectivo_contado: -1 })).status, 400);
        assert.equal((await cerrar(id, {})).status, 400, "el conteo es obligatorio");
        const demasiado = await cerrar(id, { efectivo_contado: 700, propinas_entregadas: 36 });
        assert.equal(demasiado.status, 400);
        assert.match(demasiado.json.error, /más propinas/);

        const abierta = await cuentaLista([linea(latte)]);
        const bloqueo = await cerrar(id, { efectivo_contado: 690, propinas_entregadas: 10 });
        assert.equal(bloqueo.status, 409);
        assert.equal(bloqueo.json.details.cuentas_abiertas, 1);
        assert.equal((await turnoDe(tokCajero)).id, id, "el turno sigue abierto");
        assert.equal((await pool.query("SELECT count(*)::int n FROM ingresos WHERE empresa_id = $1", [A])).rows[0].n, 0);
        est.cuentaAbierta = abierta;
    });

    it("cierre: guarda esperado, contado y diferencia, y genera los ingresos por método sin propinas", async () => {
        const id = est.turno;
        const r = await cerrar(id, { efectivo_contado: 685, propinas_entregadas: 10, nota: "Faltaron 5", forzar: true });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const { turno, corte, ingresos, impresion } = r.json.data;
        assert.equal(turno.estado, "CERRADO");
        assert.equal(corte.efectivo_esperado, 690, "500 + 200 - 10 de propinas entregadas");
        assert.equal(Number(turno.efectivo_contado), 685);
        assert.equal(Number(turno.diferencia), -5);
        assert.equal(turno.nota_cierre, "Faltaron 5");
        assert.equal(ingresos.length, 3);

        const filas = (await pool.query("SELECT metodo_pago, monto::float AS monto, fecha, pos_turno_id, concepto FROM ingresos WHERE empresa_id = $1 ORDER BY metodo_pago", [A])).rows;
        assert.deepEqual(filas.map((f) => [f.metodo_pago, f.monto]), [["EFECTIVO", 175], ["TARJETA", 55], ["TRANSFERENCIA", 120]]);
        assert.ok(filas.every((f) => f.pos_turno_id === id && f.fecha === turno.fecha_negocio));
        assert.match(filas[0].concepto, /Corte de caja/);

        // El corte queda en la cola de impresión con los totales.
        const job = (await pool.query("SELECT tipo, payload FROM pos_impresiones WHERE id = $1", [impresion.impresion_id])).rows[0];
        assert.equal(job.tipo, "CORTE");
        assert.equal(job.payload.efectivo_esperado, 690);
        assert.equal(job.payload.contado, 685);
        assert.equal(job.payload.diferencia, -5);
        assert.equal(job.payload.ventas, 350);
    });

    it("turno cerrado: no se cierra otra vez, no se cobra con él y el corte sigue consultable e imprimible", async () => {
        assert.equal((await cerrar(est.turno, { efectivo_contado: 690 })).status, 409);
        const sinCaja = await cobrar(est.cuentaAbierta, [{ metodo: "TARJETA", monto: 55 }]);
        assert.equal(sinCaja.status, 409);
        assert.match(sinCaja.json.error, /Abre tu caja/);
        const c = (await req("GET", api(`/turnos/${est.turno}/corte`), { token: tokCajero })).json.data;
        assert.equal(c.turno.estado, "CERRADO");
        assert.equal(c.corte.efectivo_esperado, 690);
        const re = await req("POST", api(`/turnos/${est.turno}/corte/imprimir`), { token: tokCajero });
        assert.equal(re.status, 201);
    });

    it("la lista de turnos: el cajero ve los suyos y el supervisor todos", async () => {
        await abrirCaja(tokSupervisor, 0);
        const mios = (await req("GET", api("/turnos"), { token: tokCajero })).json.data;
        assert.deepEqual(mios.map((t) => t.cajero), ["CT-caj"]);
        assert.equal(Number(mios[0].ventas), 350);
        const todos = (await req("GET", api("/turnos"), { token: tokSupervisor })).json.data;
        assert.deepEqual(todos.map((t) => t.cajero).sort(), ["CT-caj", "CT-sup"]);
        assert.equal((await req("GET", api("/turnos"), { token: tokMesero })).status, 403);
    });

    it("con otra caja abierta se puede cerrar aunque queden cuentas abiertas; un cajero no cierra la caja de otro", async () => {
        await abrirCaja(tokCajero, 100);
        const mio = await turnoDe(tokCajero);
        const sup = await turnoDe(tokSupervisor);
        const r = await cerrar(mio.id, { efectivo_contado: 100 });
        assert.equal(r.status, 200, "la caja del supervisor sigue abierta: no bloquea");
        assert.equal(r.json.data.ingresos.length, 0, "sin ventas no hay ingresos");
        assert.equal(Number(r.json.data.turno.diferencia), 0);
        assert.equal((await cerrar(sup.id, { efectivo_contado: 0 }, tokCajero)).status, 403, "un cajero no cierra la caja de otro");
    });

    it("cobrar y cerrar a la vez: lo que se cobra queda en el turno o se rechaza, nunca se pierde del corte", async () => {
        await abrirCaja(tokCajero, 0);
        const t = await turnoDe(tokCajero);
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push(await cuentaLista([linea(latte)]));
        const [r1, r2, r3, r4, cierre] = await Promise.all([
            ...ids.map((id) => cobrar(id, [{ metodo: "TARJETA", monto: 55 }])),
            cerrar(t.id, { efectivo_contado: 0, forzar: true }, tokSupervisor), // un supervisor cierra la caja del cajero
        ]);
        assert.equal(cierre.status, 200);
        const cobrados = [r1, r2, r3, r4].filter((r) => r.status === 200).length;
        const enPagos = (await pool.query("SELECT COALESCE(SUM(monto),0)::float AS s FROM pos_pagos WHERE turno_id = $1", [t.id])).rows[0].s;
        const enIngresos = (await pool.query("SELECT COALESCE(SUM(monto),0)::float AS s FROM ingresos WHERE pos_turno_id = $1", [t.id])).rows[0].s;
        assert.equal(enPagos, cobrados * 55);
        assert.equal(enIngresos, enPagos, "los ingresos del corte cuadran con los pagos del turno");
        assert.ok([r1, r2, r3, r4].every((r) => r.status === 200 || r.status === 409));
    });
});
