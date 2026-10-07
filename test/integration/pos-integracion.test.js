import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: integración con Finanzas, ventas por receta y reservaciones", { skip: SKIP }, () => {
    const A = 9451;
    const B = 9452;
    let server, base, pool, signToken, hoyISO, restarDias;
    let tokAdmin, tokMesero, tokCajero;
    let mesas = [];
    let latte, baguette;
    let hoy, ayer;

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
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_pagos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuenta_items WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_comandas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuentas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_turnos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_folios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM reservaciones WHERE empresa_id = ANY($1)", e);
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
    const cuentaLista = async (lineas) => {
        const mesa = mesas[siguienteMesa++ % mesas.length];
        const c = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 2 } })).json.data;
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: { lineas } });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        return c.id;
    };
    const cobrar = (id, pagos) => req("POST", api(`/cuentas/${id}/cobrar`), { token: tokCajero, body: { pagos } });
    const resumen = async (desde, hasta) => (await req("GET", `/api/finanzas/${A}/resumen?desde=${desde}&hasta=${hasta}&agrupar=dia`, { token: tokAdmin })).json.data;
    const estado = async (token = tokMesero) => (await req("GET", `/api/reportes/${A}/pos?fecha=${hoy}`, { token })).json.data;

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ hoyISO, restarDias } = await import("../../src/utils/fecha.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        hoy = hoyISO();
        ayer = restarDias(hoy, 1);

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Café Integra'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "IN-adm", { admin: true });
        tokMesero = await mkUsuario(A, "IN-mes", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "IN-caj", { rol: "cajero" });

        for (let i = 1; i <= 6; i++) mesas.push((await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);

        const provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        const leche = (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin, body: { producto: "Leche", categoria: "Insumo", unidad_medida: "pz", proveedor_id: provId, cantidad_presentacion: 1, costo_presentacion: 10, stock_minimo: 0, stock_actual: 100 },
        })).json.data.id;
        const mkReceta = async (b) => (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body: { ...b, ingredientes: [{ producto_id: leche, cantidad: 1 }] } })).json.data.id;
        latte = { tipo: "RECETA", id: await mkReceta({ nombre: "Latte", categoria: "Bebidas", precio_venta: 55 }) };
        baguette = { tipo: "RECETA", id: await mkReceta({ nombre: "Baguette", categoria: "Platillos", precio_venta: 120 }) };
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("antes de operar con el POS: Inicio no lo marca activo y la empresa nueva no figura como importadora de CSV", async () => {
        assert.equal((await estado()).activo, false);
        assert.equal((await estado()).csv_importado, undefined, "la importación del CSV ya no existe");
    });

    it("abrir caja: el turno queda abierto y el POS pasa a figurar activo", async () => {
        const abierta = await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 300 } });
        assert.equal(abierta.status, 201);
        assert.equal(abierta.json.data.csv_importado, undefined);
        const actual = await req("GET", api("/turnos/actual"), { token: tokCajero });
        assert.equal(actual.json.data.id, abierta.json.data.id);
        assert.equal((await estado()).activo, true);
    });

    it("cobrar una cuenta en la caja abierta", async () => {
        const c = await cuentaLista([linea(latte), linea(baguette)]);
        assert.equal((await cobrar(c, [{ metodo: "EFECTIVO", monto: 175, recibido: 200 }])).status, 200);
    });

    it("el cierre manual por lote ya no existe; el ingreso individual sigue disponible", async () => {
        const lote = await req("POST", `/api/finanzas/${A}/ingresos/lote`, { token: tokAdmin, body: { fecha: ayer, lineas: [{ metodo_pago: "EFECTIVO", monto: 10 }] } });
        assert.equal(lote.status, 404);
        const solo = await req("POST", `/api/finanzas/${A}/ingresos`, {
            token: tokAdmin, body: { fecha: hoy, metodo_pago: "EFECTIVO", monto: 20, concepto: "Ventas antes del POS" },
        });
        assert.equal(solo.status, 201);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = $1 AND fecha = $2", [A, hoy]);
    });

    it("Finanzas: el ingreso esperado suma lo cobrado en el POS y avisa de la caja sin cerrar", async () => {
        const abierto = await resumen(hoy, hoy);
        assert.equal(abierto.ingreso_esperado, 175, "una cuenta de $175");
        assert.equal(abierto.ingresos_comparables, 0, "el corte aún no genera ingresos");
        assert.deepEqual(abierto.dias_turno_abierto, [hoy]);
        assert.deepEqual(abierto.dias_sin_ingreso, [], "esa lista es solo de días importados por CSV");
        // Costo y ventas comparables mientras la caja sigue abierta: el food cost no se dispara ni queda en null.
        assert.equal(abierto.ventas_pos_sin_corte.cuentas, 1);
        assert.equal(abierto.ventas_pos_sin_corte.total, 175);
        assert.equal(abierto.ingresos.total, 0, "los ingresos/flujo no cuentan lo que no se ha cortado");
        assert.notEqual(abierto.food_cost_pct, null);

        const turno = (await req("GET", api("/turnos/actual"), { token: tokCajero })).json.data;
        const cierre = await req("POST", api(`/turnos/${turno.id}/cerrar`), { token: tokCajero, body: { efectivo_contado: 475 } });
        assert.equal(cierre.status, 200, JSON.stringify(cierre.json));

        const cerrado = await resumen(hoy, hoy);
        assert.equal(cerrado.ingreso_esperado, 175);
        assert.equal(cerrado.ingresos_comparables, 175, "ahora sí hay ingresos de ese día");
        assert.equal(cerrado.ingresos.total, 175);
        assert.deepEqual(cerrado.dias_turno_abierto, []);
        assert.equal(cerrado.ventas_pos_sin_corte.total, 0, "ya cortada: pasa de 'sin corte' a ingresos, sin contarse doble");
        assert.equal(cerrado.food_cost_pct, abierto.food_cost_pct, "el food cost no cambia al cerrar la caja");
    });

    it("ventas por receta: incluye lo cobrado en el POS, con descuentos y sin cancelados", async () => {
        const c = await cuentaLista([linea(latte, 2), linea(baguette)]);
        const detalle = (await req("GET", api(`/cuentas/${c}`), { token: tokMesero })).json.data;
        const itemLatte = detalle.items.find((i) => i.nombre === "Latte");
        // 10% al latte (2 × 55 = 110 → 99): el administrador se autoriza a sí mismo.
        const d = await req("POST", api(`/cuentas/${c}/items/${itemLatte.id}/descuento`), { token: tokAdmin, body: { tipo: "PORCENTAJE", valor: 10, motivo: "Cliente frecuente" } });
        assert.equal(d.status, 200, JSON.stringify(d.json));
        await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 100 } });
        assert.equal((await cobrar(c, [{ metodo: "TARJETA", monto: 219 }])).status, 200);

        const r = await req("GET", `/api/recetas/${A}/ventas?desde=${hoy}&hasta=${hoy}`, { token: tokAdmin });
        assert.equal(r.status, 200);
        const { recetas, dias_importados, dias_pos } = r.json.data;
        assert.equal(dias_importados, 1);
        assert.equal(dias_pos, 1);
        const l = recetas.find((x) => x.nombre === "Latte");
        const b = recetas.find((x) => x.nombre === "Baguette");
        // Primera cuenta: 1 latte + 1 baguette. Segunda: 2 lattes (−$11) + 1 baguette.
        assert.equal(l.unidades, 3);
        assert.equal(l.ingreso, 55 + 99);
        assert.equal(b.unidades, 2);
        assert.equal(b.ingreso, 240);
    });

    it("Inicio: el POS figura activo; una caja de días anteriores sin cerrar se reporta", async () => {
        assert.equal((await estado()).activo, true);
        assert.deepEqual((await estado()).turnos_sin_cerrar, []);

        await pool.query("UPDATE pos_turnos SET fecha_negocio = $2 WHERE empresa_id = $1 AND estado = 'ABIERTO'", [A, ayer]);
        const pos = await estado();
        assert.equal(pos.turnos_sin_cerrar.length, 1);
        assert.equal(pos.turnos_sin_cerrar[0].fecha_negocio, ayer);
        assert.equal(pos.turnos_sin_cerrar[0].cajero, "IN-caj");
        await pool.query("UPDATE pos_turnos SET fecha_negocio = $2 WHERE empresa_id = $1 AND estado = 'ABIERTO'", [A, hoy]);

        // Aislamiento: otra empresa no ve nada de esto.
        const otra = await mkUsuario(B, "IN-admB", { admin: true });
        const res = await req("GET", `/api/reportes/${B}/pos?fecha=${hoy}`, { token: otra });
        assert.equal(res.json.data.activo, false);
    });

    it("reservación: abrir su cuenta la marca sentada, queda ligada y no se duplica", async () => {
        const res = (await req("POST", `/api/reservaciones/${A}`, {
            token: tokAdmin, body: { nombre_cliente: "Ana", telefono_cliente: "555", fecha: hoy, hora: "20:00", personas: 4 },
        })).json.data;
        assert.equal(res.estado, "pendiente");
        assert.equal(res.cuenta_id, null);

        const mesa = (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas.find((m) => m.cuentas.length === 0).id;
        const abierta = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 4, nombre_cliente: "Ana", reservacion_id: res.id } });
        assert.equal(abierta.status, 201);

        const lista = (await req("GET", `/api/reservaciones/${A}?desde=${hoy}&hasta=${hoy}`, { token: tokAdmin })).json.data;
        const ligada = lista.find((x) => x.id === res.id);
        assert.equal(ligada.estado, "sentada");
        assert.equal(ligada.cuenta_id, abierta.json.data.id);
        assert.equal(ligada.cuenta_folio, abierta.json.data.folio);

        const otraMesa = (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas.find((m) => m.cuentas.length === 0).id;
        const doble = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: otraMesa, personas: 4, reservacion_id: res.id } });
        assert.equal(doble.status, 409);
        assert.match(doble.json.error, new RegExp(`folio ${abierta.json.data.folio}`));

        // Cancelar la cuenta libera la reservación para abrir otra.
        await req("POST", api(`/cuentas/${abierta.json.data.id}/cancelar`), { token: tokMesero, body: { motivo: "Cambio de mesa" } });
        const otra = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: otraMesa, personas: 4, reservacion_id: res.id } });
        assert.equal(otra.status, 201);
    });

    it("reservación: salir de su cuenta sin productos la devuelve a confirmada (no queda sentada)", async () => {
        const res = (await req("POST", `/api/reservaciones/${A}`, {
            token: tokAdmin, body: { nombre_cliente: "Beto", telefono_cliente: "555", fecha: hoy, hora: "21:00", personas: 2 },
        })).json.data;
        const mesa = (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas.find((m) => m.cuentas.length === 0).id;
        const cuenta = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 2, reservacion_id: res.id } })).json.data;
        const estadoRes = async () => (await req("GET", `/api/reservaciones/${A}?desde=${hoy}&hasta=${hoy}`, { token: tokAdmin })).json.data.find((x) => x.id === res.id);
        assert.equal((await estadoRes()).estado, "sentada");
        assert.equal((await req("POST", api(`/cuentas/${cuenta.id}/descartar`), { token: tokMesero })).json.data.eliminada, true);
        const despues = await estadoRes();
        assert.equal(despues.estado, "confirmada");
        assert.equal(despues.cuenta_id, null);
    });
});
