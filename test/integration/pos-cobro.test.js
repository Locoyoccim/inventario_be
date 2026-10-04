import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: cobro, pagos, inventario y cierre de mesa", { skip: SKIP }, () => {
    const A = 9421;
    const B = 9422;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor, tokAdminB;
    let mesas = [];
    let latte, baguette, pellegrino, leche, pelId;
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
    const stock = async (productoId) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [productoId])).rows[0].stock_actual);
    const movs = async (cuentaId) => (await pool.query("SELECT producto_id, tipo_movimiento, cantidad FROM movimientosinventario WHERE referencia_tipo = 'POS_CUENTA' AND referencia_id = $1 ORDER BY id", [cuentaId])).rows;
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
        tokAdmin = await mkUsuario(A, "CB-adm", { admin: true });
        tokMesero = await mkUsuario(A, "CB-mes", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "CB-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "CB-sup", { rol: "supervisor" });
        tokAdminB = await mkUsuario(B, "CB-admB", { admin: true });

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
        pellegrino = { tipo: "PRODUCTO", id: pelId };
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("permisos y requisitos: mesero no cobra; sin caja abierta no se cobra; con productos sin enviar tampoco", async () => {
        const id = await cuentaLista([linea(latte)]);
        assert.equal((await cobrar(id, [{ metodo: "TARJETA", monto: 55 }], tokMesero)).status, 403);
        const sinCaja = await cobrar(id, [{ metodo: "TARJETA", monto: 55 }]);
        assert.equal(sinCaja.status, 409);
        assert.match(sinCaja.json.error, /Abre tu caja/);

        assert.equal((await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 500 } })).status, 201);
        await req("POST", api(`/cuentas/${id}/items`), { token: tokMesero, body: { lineas: [linea(baguette)] } });
        const sinEnviar = await cobrar(id, [{ metodo: "TARJETA", monto: 175 }]);
        assert.equal(sinEnviar.status, 400);
        assert.match(sinEnviar.json.error, /sin enviar/);
        await req("POST", api(`/cuentas/${id}/enviar`), { token: tokMesero });
        est.pendiente = id;
        assert.equal(await stock(leche), 10, "nada se descontó por intentos rechazados");
    });

    it("pagos inválidos se rechazan completos: la cuenta sigue abierta y el inventario intacto", async () => {
        const id = est.pendiente; // Latte 55 + Baguette 120 = 175
        assert.equal((await cobrar(id, [])).status, 400);
        const falta = await cobrar(id, [{ metodo: "TARJETA", monto: 100 }]);
        assert.equal(falta.status, 400);
        assert.match(falta.json.error, /Faltan 75\.00/);
        assert.equal((await cobrar(id, [{ metodo: "EFECTIVO", monto: 175, recibido: 150 }])).status, 400);
        assert.equal((await cobrar(id, [{ metodo: "CHEQUE", monto: 175 }])).status, 400);
        const cuenta = (await req("GET", api(`/cuentas/${id}`), { token: tokCajero })).json.data;
        assert.equal(cuenta.estado, "ABIERTA");
        assert.equal(cuenta.pagos.length, 0);
        assert.equal(await stock(leche), 10);
        assert.equal((await movs(id)).length, 0);
    });

    it("cobro mixto con propina y cambio: cierra la cuenta, descuenta el inventario y encola el ticket", async () => {
        const id = est.pendiente;
        const r = await cobrar(id, [
            { metodo: "TARJETA", monto: 100, propina: 10, referencia: "AUT-123" },
            { metodo: "EFECTIVO", monto: 75, recibido: 100 },
        ]);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const { cuenta, cambio, propina, ticket, inventario } = r.json.data;
        assert.equal(cambio, 25);
        assert.equal(propina, 10);
        assert.equal(cuenta.estado, "PAGADA");
        assert.equal(cuenta.totales.total, 175);
        assert.equal(Number(cuenta.propina), 10);
        assert.deepEqual(cuenta.pagos.map((p) => [p.metodo, Number(p.monto), Number(p.propina), p.recibido === null ? null : Number(p.recibido), p.cambio === null ? null : Number(p.cambio)]),
            [["TARJETA", 100, 10, null, null], ["EFECTIVO", 75, 0, 100, 25]]);
        assert.equal(cuenta.pagos[0].referencia, "AUT-123");
        assert.deepEqual(inventario.negativos, []);

        assert.equal(await stock(leche), 8, "Latte y Baguette consumen 1 leche cada uno");
        const mv = await movs(id);
        assert.deepEqual(mv.map((m) => m.tipo_movimiento), ["VENTA"]);
        assert.equal(Number(mv[0].cantidad), 2);

        // Cada pago quedó ligado al turno del cajero y la cuenta al día de ese turno.
        const turno = (await pool.query("SELECT id, fecha_negocio FROM pos_turnos WHERE empresa_id = $1 AND estado = 'ABIERTO'", [A])).rows[0];
        const pagos = (await pool.query("SELECT turno_id FROM pos_pagos WHERE cuenta_id = $1", [id])).rows;
        assert.ok(pagos.every((p) => p.turno_id === turno.id));
        assert.equal(cuenta.turno_id, turno.id);
        assert.equal(cuenta.fecha_negocio, turno.fecha_negocio);
        assert.ok(cuenta.cerrada_at);

        // Ticket: sin impresora configurada queda en ERROR (no bloquea el cobro) y abre el cajón por el efectivo.
        assert.equal(ticket.impresion_estado, "ERROR");
        const payload = (await pool.query("SELECT payload FROM pos_impresiones WHERE id = $1", [ticket.impresion_id])).rows[0].payload;
        assert.equal(payload.tipo, "TICKET");
        assert.equal(payload.abrir_cajon, true);
        assert.equal(payload.cambio, 25);
        assert.equal(payload.cajero, "CB-caj");
        assert.deepEqual(payload.items.map((i) => [i.cantidad, i.nombre, i.importe]), [[1, "Latte", 55], [1, "Baguette", 120]]);
        est.pagada = id;
    });

    it("cobrar de nuevo la misma cuenta responde 409 y no vuelve a descontar", async () => {
        const otra = await cobrar(est.pagada, [{ metodo: "TARJETA", monto: 175 }]);
        assert.equal(otra.status, 409);
        assert.equal(await stock(leche), 8);
        assert.equal((await movs(est.pagada)).length, 1);
    });

    it("dos cajas cobrando a la vez: solo una gana y el inventario baja una sola vez", async () => {
        await req("POST", api("/turnos/abrir"), { token: tokSupervisor, body: { fondo_inicial: 0 } });
        const id = await cuentaLista([linea(latte)]);
        const antes = await stock(leche);
        const rs = await Promise.all([
            cobrar(id, [{ metodo: "TARJETA", monto: 55 }], tokCajero),
            cobrar(id, [{ metodo: "TRANSFERENCIA", monto: 55 }], tokSupervisor),
        ]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
        assert.equal(await stock(leche), antes - 1);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pos_pagos WHERE cuenta_id = $1", [id])).rows[0].n, 1);
    });

    it("lo cancelado antes de cobrar no toca el inventario", async () => {
        const id = await cuentaLista([linea(latte), linea(baguette)]);
        const bag = (await req("GET", api(`/cuentas/${id}`), { token: tokCajero })).json.data.items.find((i) => i.nombre === "Baguette");
        await req("POST", api(`/cuentas/${id}/items/${bag.id}/cancelar`), { token: tokSupervisor, body: { motivo: "Se quemó" } });
        const antes = await stock(leche);
        const r = await cobrar(id, [{ metodo: "TRANSFERENCIA", monto: 55 }]);
        assert.equal(r.status, 200);
        assert.equal(await stock(leche), antes - 1, "solo el Latte");
        assert.equal(r.json.data.cuenta.totales.total, 55);
        const payload = (await pool.query("SELECT payload FROM pos_impresiones WHERE id = $1", [r.json.data.ticket.impresion_id])).rows[0].payload;
        assert.equal(payload.abrir_cajon, false, "sin efectivo no se abre el cajón");
        assert.equal(payload.items.length, 1);
    });

    it("producto sin receta (Pellegrino) descuenta su existencia; el stock negativo no bloquea la venta y se reporta", async () => {
        const id = await cuentaLista([linea(pellegrino, 2)]);
        await pool.query("UPDATE inventario SET stock_actual = 1 WHERE producto_id = $1", [pelId]);
        const r = await cobrar(id, [{ metodo: "TARJETA", monto: 90 }]);
        assert.equal(r.status, 200);
        assert.equal(await stock(pelId), -1);
        assert.deepEqual(r.json.data.inventario.negativos.map((n) => [n.producto, n.stock_nuevo]), [["Pellegrino", -1]]);
    });

    it("el ticket se reimprime como copia (sin volver a abrir cajón) y una cuenta abierta no tiene ticket", async () => {
        const abierta = await cuentaLista([linea(latte)]);
        assert.equal((await req("POST", api(`/cuentas/${abierta}/ticket`), { token: tokCajero })).status, 404);

        // Sin impresora de tickets no hay dónde reimprimir; con una configurada, el trabajo vuelve a la cola.
        assert.equal((await req("POST", api(`/cuentas/${est.pagada}/ticket`), { token: tokCajero })).status, 400);
        await req("POST", api("/impresoras"), { token: tokAdmin, body: { nombre: "Caja", conexion: "RED", ip: "192.168.1.60", es_ticket: true, ancho: 58 } });
        const re = await req("POST", api(`/cuentas/${est.pagada}/ticket`), { token: tokCajero });
        assert.equal(re.status, 200);
        assert.equal(re.json.data.estado, "PENDIENTE");
        const fila = (await pool.query("SELECT reimpresiones FROM pos_impresiones WHERE id = $1", [re.json.data.id])).rows[0];
        assert.equal(fila.reimpresiones, 0, "el ticket original nunca se imprimió: esta es su primera salida, no una copia");
        await pool.query("UPDATE pos_impresiones SET estado = 'IMPRESO', impreso_at = now() WHERE id = $1", [re.json.data.id]);
        await req("POST", api(`/cuentas/${est.pagada}/ticket`), { token: tokCajero });
        assert.equal((await pool.query("SELECT reimpresiones FROM pos_impresiones WHERE id = $1", [re.json.data.id])).rows[0].reimpresiones, 1, "ya impreso: la siguiente sí es copia");
    });

    it("la mesa queda libre al cobrar y otra empresa no puede cobrar ni ver la cuenta", async () => {
        const mapa = (await req("GET", api("/mapa"), { token: tokCajero })).json.data;
        const mesaPagada = (await pool.query("SELECT mesa_id FROM pos_cuentas WHERE id = $1", [est.pagada])).rows[0].mesa_id;
        assert.equal(mapa.mesas.find((m) => m.id === mesaPagada).cuentas.length, 0);
        const nueva = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesaPagada } });
        assert.equal(nueva.status, 201, "la misma mesa se vuelve a abrir");

        const id = await cuentaLista([linea(latte)]);
        const ajeno = await req("POST", `/api/pos/${A}/cuentas/${id}/cobrar`, { token: tokAdminB, body: { pagos: [{ metodo: "TARJETA", monto: 55 }] } });
        assert.ok([403, 404].includes(ajeno.status), `status ${ajeno.status}`);
        assert.equal((await req("GET", api(`/cuentas/${id}`), { token: tokCajero })).json.data.estado, "ABIERTA");
    });
});
