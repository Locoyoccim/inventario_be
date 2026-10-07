import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { iniciarServidor } from "../helpers/servidor.js";

// Análisis del negocio: ingeniería de menú, costo teórico contra real y control de fugas, sobre ventas reales del POS.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — análisis del negocio", { skip: SKIP }, () => {
    const A = 9711;
    const B = 9712;
    const PASS = "Clave-Segura-1";
    let server, base, pool, signToken, hoy;
    let tokAdmin, tokMesero1, tokMesero2, tokCajero, tokSupervisor, tokAdminB;
    let mesas = [];
    let leche, harina, latte, pan, torta, cafe;
    const ids = {};

    const req = async (method, path, { token = tokAdmin, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json };
    };
    const api = (p) => `/api/pos/${A}${p}`;
    const analisis = async (que, token = tokAdmin, e = A) => req("GET", `/api/analisis/${e}/${que}?desde=${hoy}&hasta=${hoy}`, { token });

    const limpiar = async () => {
        const e = [[A, B]];
        for (const t of ["conteo_detalle|conteo_id IN (SELECT id FROM conteo_fisico WHERE empresa_id = ANY($1))", "conteo_fisico|empresa_id = ANY($1)", "ingresos|empresa_id = ANY($1)",
            "pos_impresiones|empresa_id = ANY($1)", "impresoras|empresa_id = ANY($1)", "pos_autorizaciones|empresa_id = ANY($1)", "pos_devoluciones|empresa_id = ANY($1)",
            "pos_pagos|empresa_id = ANY($1)", "pos_cuenta_items|empresa_id = ANY($1)", "pos_comandas|empresa_id = ANY($1)", "pos_cuentas|empresa_id = ANY($1)", "pos_turnos|empresa_id = ANY($1)",
            "pos_folios|empresa_id = ANY($1)", "movimientosinventario|producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))",
            "receta_detalle|receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", "recetas|empresa_id = ANY($1)", "inventario|empresa_id = ANY($1)", "productos|empresa_id = ANY($1)",
            "proveedores|empresa_id = ANY($1)", "categorias|empresa_id = ANY($1)", "mesas|empresa_id = ANY($1)", "areas_preparacion|empresa_id = ANY($1)", "usuarios|empresa_id = ANY($1)"]) {
            const [tabla, donde] = t.split("|");
            await pool.query(`DELETE FROM ${tabla} WHERE ${donde}`, e);
        }
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    const mkUsuario = async (empresa, codigo, { admin = false, rol = null, email = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id,email,password_hash) VALUES ($1,$1,$2,$2,$3,$4,$5,$6) RETURNING id",
            [codigo, admin, empresa, rolId, email, email ? await bcrypt.hash(PASS, 4) : null],
        )).rows[0].id;
        ids[codigo] = id;
        return signToken({ id, empresa_id: empresa, is_admin: admin, is_owner: admin, tv: 0 });
    };

    let siguienteMesa = 0;
    const sup = { email: "sup@an.test", password: PASS };
    // Cuenta del mesero con las líneas, ya enviada.
    const cuenta = async (token, lineas) => {
        const c = (await req("POST", api("/cuentas"), { token, body: { tipo: "MESA", mesa_id: mesas[siguienteMesa++ % mesas.length], personas: 1 } })).json.data;
        await req("POST", api(`/cuentas/${c.id}/items`), { token, body: { lineas } });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token });
        return (await req("GET", api(`/cuentas/${c.id}`), { token })).json.data;
    };
    const linea = (a, cantidad = 1) => ({ tipo: "RECETA", id: a, cantidad });
    const cobrar = (c, pagos) => req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: { pagos } });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        const { hoyISO } = await import("../../src/utils/fecha.js");
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Análisis'), ($2,'Otra')", [A, B]);
        hoy = hoyISO(new Date(), (await pool.query("SELECT zona_horaria FROM empresas WHERE id = $1", [A])).rows[0].zona_horaria);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n", [[A, B], ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "AN-adm", { admin: true });
        tokMesero1 = await mkUsuario(A, "AN-m1", { rol: "mesero" });
        tokMesero2 = await mkUsuario(A, "AN-m2", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "AN-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "AN-sup", { rol: "supervisor", email: sup.email });
        tokAdminB = await mkUsuario(B, "AN-admB", { admin: true });
        for (let i = 1; i <= 8; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);

        const provId = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const prod = async (b) => (await req("POST", `/api/productos/${A}`, {
            body: { unidad_medida: "pz", proveedor_id: provId, cantidad_presentacion: 1, stock_minimo: 0, categoria: "Insumo", ...b },
        })).json.data.id;
        leche = await prod({ producto: "Leche", costo_presentacion: 10, stock_actual: 100 });
        harina = await prod({ producto: "Harina", costo_presentacion: 5, stock_actual: 100 });
        const receta = async (nombre, categoria, precio_venta, ingredientes) =>
            (await req("POST", `/api/recetas/${A}`, { body: { nombre, categoria, precio_venta, ingredientes } })).json.data.id;
        latte = await receta("Latte", "Bebidas", 58, [{ producto_id: leche, cantidad: 1 }]); // costo 10
        pan = await receta("Pan", "Platillos", 40, [{ producto_id: harina, cantidad: 2 }]); // costo 10
        torta = await receta("Torta", "Platillos", 120, [{ producto_id: harina, cantidad: 4 }, { producto_id: leche, cantidad: 1 }]); // costo 30
        cafe = await receta("Café", "Bebidas", 30, [{ producto_id: leche, cantidad: 0.5 }]); // costo 5
        await receta("Sin ventas", "Platillos", 99, [{ producto_id: harina, cantidad: 1 }]);
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("el análisis es solo para Admin y respeta la empresa", async () => {
        for (const que of ["menu", "consumo", "fugas"]) {
            assert.equal((await analisis(que, tokMesero1)).status, 403, `${que}: un mesero no entra`);
            assert.equal((await analisis(que, tokCajero)).status, 403);
            assert.equal((await analisis(que, tokAdminB)).status, 403, `${que}: otra empresa no ve estos datos`);
            assert.equal((await analisis(que)).status, 200);
        }
        assert.equal((await req("GET", `/api/analisis/${A}/menu?desde=2026-02-01&hasta=2026-01-01`)).status, 400);
        assert.equal((await req("GET", `/api/analisis/${A}/menu?desde=2024-01-01&hasta=2026-01-01`)).status, 400, "rango máximo de 366 días");
        const vacio = (await analisis("menu")).json.data;
        assert.equal(vacio.items.length, 0, "sin ventas no hay nada que clasificar");
        assert.equal(vacio.sin_ventas.length, 5, "todas las recetas activas aparecen como sin ventas");
    });

    it("ventas reales del POS: descuentos, cortesía, una venta cancelada con merma y un conteo con faltante", async () => {
        assert.equal((await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 0 } })).status, 201);
        // Mesero 1 vende con descuentos: tres tortas al 50 % y un pan de cortesía.
        for (let i = 0; i < 3; i++) {
            const c = await cuenta(tokMesero1, [linea(torta)]);
            const d = await req("POST", api(`/cuentas/${c.id}/descuento`), { token: tokMesero1, body: { tipo: "PORCENTAJE", valor: 50, motivo: "Cliente frecuente", autorizacion: sup } });
            assert.equal(d.status, 200, JSON.stringify(d.json));
            assert.equal((await cobrar(c, [{ metodo: "TARJETA", monto: 60 }])).status, 200);
        }
        const conPan = await cuenta(tokMesero1, [linea(pan)]);
        const cortesia = await req("POST", api(`/cuentas/${conPan.id}/items/${conPan.items[0].id}/descuento`), { token: tokMesero1, body: { tipo: "CORTESIA", motivo: "Disculpa", autorizacion: sup } });
        assert.equal(cortesia.status, 200, JSON.stringify(cortesia.json));
        assert.equal((await cobrar(conPan, [])).status, 200);
        // Mesero 2 vende sin descuentos.
        const grande = await cuenta(tokMesero2, [linea(latte, 6)]);
        assert.equal((await cobrar(grande, [{ metodo: "TARJETA", monto: 348 }])).status, 200);
        const chico = await cuenta(tokMesero2, [linea(cafe)]);
        assert.equal((await cobrar(chico, [{ metodo: "TARJETA", monto: 30 }])).status, 200);
        // Un latte que se canceló ya preparado.
        const perdido = await cuenta(tokMesero2, [linea(latte)]);
        const cancel = await req("POST", api(`/cuentas/${perdido.id}/items/${perdido.items[0].id}/cancelar`), { token: tokSupervisor, body: { motivo: "Se cayó", merma: true } });
        assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
        await req("POST", api(`/cuentas/${perdido.id}/cancelar`), { token: tokSupervisor, body: { motivo: "x" } });
        // Conteo de la harina: el sistema tiene 86 y hay 83 (faltan 3).
        const conteo = await req("POST", `/api/conteos/${A}`, { body: { lineas: [{ producto_id: harina, stock_fisico: 83 }] } });
        assert.equal(conteo.status, 201, JSON.stringify(conteo.json));
    });

    it("ingeniería de menú: unidades, ventas sin IVA con descuentos, margen y clase de cada artículo", async () => {
        const r = (await analisis("menu")).json.data;
        const por = (id) => r.items.find((i) => i.id === id);
        assert.equal(r.items.length, 4);
        assert.equal(por(torta).unidades, 3);
        assert.equal(por(torta).ventas_netas, 155.17, "3 × 60 con IVA ÷ 1.16");
        assert.equal(por(torta).costo, 90);
        assert.equal(por(torta).margen, 65.17);
        assert.equal(por(latte).unidades, 6, "el latte cancelado no cuenta");
        assert.equal(por(latte).ventas_netas, 300);
        assert.equal(por(pan).ventas_netas, 0, "la cortesía no deja venta");
        assert.equal(por(pan).margen, -10, "pero sí cuesta");
        assert.equal(por(latte).clase, "estrella");
        assert.equal(por(torta).clase, "popular");
        assert.equal(por(pan).clase, "revisar");
        assert.equal(por(cafe).clase, "revisar");
        assert.equal(r.totales.unidades, 11);
        assert.equal(r.suficiente, true);
        assert.equal(r.sin_ventas.length, 1);
        assert.equal(r.sin_ventas[0].nombre, "Sin ventas");
        assert.equal(r.objetivo_food_cost, 30);
        // La torta cuesta 30 y se cobra con descuento: pero el precio de lista (120) ya cumple el objetivo.
        assert.equal(por(torta).precio_sugerido, null);
    });

    it("costo teórico vs real: consumo por receta, merma del latte cancelado y faltante de la harina", async () => {
        const r = (await analisis("consumo")).json.data;
        const i = (id) => r.items.find((x) => x.producto_id === id);
        assert.equal(i(harina).teorico_valor, 70, "14 piezas × $5: 3 tortas × 4 + 1 pan × 2");
        assert.equal(i(harina).diferencia_conteo_valor, -15, "faltan 3 piezas");
        assert.equal(i(harina).perdida_valor, 15);
        assert.equal(i(harina).desviacion_pct, 21.43);
        assert.equal(i(harina).nivel, "alto");
        assert.equal(i(harina).contado_en_periodo, true);
        assert.equal(i(leche).teorico_valor, 95, "6 + 3 + 0.5 piezas × $10");
        assert.equal(i(leche).merma_valor, 10, "el latte cancelado ya preparado");
        assert.equal(i(leche).nivel, "alto");
        assert.equal(i(leche).contado_en_periodo, false, "la leche no se contó: no se sabe si falta");
        assert.equal(r.totales.teorico_valor, 165);
        assert.equal(r.totales.perdida_valor, 25);
        assert.equal(r.totales.real_valor, 190);
        assert.equal(r.totales.sin_conteo_insumos, 1);
        assert.equal(r.totales.alertas_altas, 2);
        assert.ok(r.totales.ventas_netas > 0);
        assert.equal(r.totales.teorico_pct_ventas, Number(((165 / r.totales.ventas_netas) * 100).toFixed(2)));
        assert.equal(r.serie.length, 1);
        assert.equal(r.serie[0].teorico_valor, 165);
        assert.equal(r.serie[0].perdida_valor, 25);
    });

    it("control de fugas: eventos por tipo y persona, mesero con descuentos marcado y merma de lo cancelado", async () => {
        const r = (await analisis("fugas")).json.data;
        assert.equal(r.totales.eventos, 5);
        assert.equal(r.totales.monto, 278, "3 × 60 de descuento + 40 de cortesía + 58 cancelado");
        assert.equal(r.totales.ventas, 558, "180 + 348 + 30 cobrados");
        assert.equal(r.totales.merma_cancelaciones, 10);
        const tipo = (t) => r.por_tipo.find((x) => x.tipo === t);
        assert.deepEqual([tipo("DESCUENTO").eventos, tipo("DESCUENTO").monto], [3, 180]);
        assert.deepEqual([tipo("CORTESIA").eventos, tipo("CORTESIA").monto], [1, 40]);
        assert.deepEqual([tipo("CANCELAR_ITEM").eventos, tipo("CANCELAR_ITEM").monto], [1, 58]);
        const m1 = r.por_usuario.find((u) => u.usuario_id === ids["AN-m1"]);
        assert.equal(m1.eventos, 4);
        assert.equal(m1.monto, 220);
        assert.equal(m1.ventas, 180);
        assert.equal(m1.atipico, true, "descuenta mucho más que el resto frente a lo que vende");
        assert.equal(r.por_usuario[0].usuario_id, ids["AN-m1"], "el de mayor monto va primero");
        assert.equal(r.por_usuario.find((u) => u.usuario_id === ids["AN-sup"]).eventos, 1, "lo que el supervisor hizo directo es suyo");
        assert.equal(r.por_autorizador.find((u) => u.usuario_id === ids["AN-sup"]).eventos, 5);
        assert.equal(r.recientes.length, 5);
        assert.ok(r.recientes.every((e) => e.motivo && e.folio));
    });

    it("fuera del periodo no aparece nada", async () => {
        const antes = (await req("GET", `/api/analisis/${A}/fugas?desde=2020-01-01&hasta=2020-01-31`)).json.data;
        assert.equal(antes.totales.eventos, 0);
        assert.equal(antes.totales.pct_ventas, null);
        const consumo = (await req("GET", `/api/analisis/${A}/consumo?desde=2020-01-01&hasta=2020-01-31`)).json.data;
        assert.equal(consumo.items.length, 0);
        assert.equal(consumo.totales.desviacion_pct, null);
    });
});
