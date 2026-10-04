import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Correcciones de la auditoría de octubre de 2026: ingresos del corte protegidos, fechas por zona de la empresa,
// conteo con base, merma al cancelar lo ya enviado, comandas al juntar cuentas, costo al anular compras y roles.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — auditoría 2026-10", { skip: SKIP }, () => {
    const A = 9701;
    const ZONA = "Pacific/Kiritimati"; // UTC+14: casi nunca comparte el día del servidor
    let server, base, pool, signToken, hoyISO;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor;
    let mesas = [];
    let latte, leche, harina;

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

    const limpiar = async () => {
        const e = [[A]];
        await pool.query("DELETE FROM conteo_detalle WHERE conteo_id IN (SELECT id FROM conteo_fisico WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM conteo_fisico WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM gastos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias_gasto WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_autorizaciones WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_pagos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuenta_items WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_comandas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuentas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_turnos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_folios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM compra_detalle WHERE compra_id IN (SELECT id FROM compra WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM compra WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM mesas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM areas_preparacion WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    const mkUsuario = async (codigo, { admin = false, rol = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id", [codigo, admin, A, rolId],
        )).rows[0].id;
        return signToken({ id, empresa_id: A, is_admin: admin, is_owner: admin, tv: 0 });
    };

    let siguienteMesa = 0;
    const abrir = async () => (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesas[siguienteMesa++ % mesas.length], personas: 2 } })).json.data;
    const conLatte = async (cantidad = 1) => {
        const c = await abrir();
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: { lineas: [{ tipo: "RECETA", id: latte, cantidad }] } });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        return (await req("GET", api(`/cuentas/${c.id}`), { token: tokMesero })).json.data;
    };
    const stock = async (producto) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [producto])).rows[0].stock_actual);
    const movs = async (producto, tipo) => (await pool.query("SELECT cantidad::float AS cantidad, referencia_tipo FROM movimientosinventario WHERE producto_id = $1 AND tipo_movimiento = $2 ORDER BY id", [producto, tipo])).rows;
    const fijarStock = (producto, n) => pool.query("UPDATE inventario SET stock_actual = $2 WHERE producto_id = $1", [producto, n]);

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ hoyISO } = await import("../../src/utils/fecha.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre,zona_horaria) VALUES ($1,'Auditoría',$2)", [A, ZONA]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Insumo"]]);
        tokAdmin = await mkUsuario("AUD-adm", { admin: true });
        tokMesero = await mkUsuario("AUD-mes", { rol: "mesero" });
        tokCajero = await mkUsuario("AUD-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario("AUD-sup", { rol: "supervisor" });
        for (let i = 1; i <= 6; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);

        const provId = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const prod = async (b) => (await req("POST", `/api/productos/${A}`, {
            body: { unidad_medida: "pz", proveedor_id: provId, cantidad_presentacion: 1, costo_presentacion: 10, stock_minimo: 0, ...b },
        })).json.data.id;
        leche = await prod({ producto: "Leche", categoria: "Insumo", stock_actual: 100 });
        harina = await prod({ producto: "Harina", categoria: "Insumo", stock_actual: 100 });
        latte = (await req("POST", `/api/recetas/${A}`, { body: { nombre: "Latte", categoria: "Bebidas", precio_venta: 55, ingredientes: [{ producto_id: leche, cantidad: 1 }] } })).json.data.id;
        const barra = (await req("GET", api("/areas"))).json.data.find((a) => a.nombre === "Barra").id;
        await req("PUT", api(`/asignacion-areas/receta/${latte}`), { body: { area_id: barra } });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    // ---------- 1. Ingresos del corte de caja ----------
    it("el ingreso que genera el corte de caja no se edita ni se anula en Finanzas; los manuales sí", async () => {
        await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 100 } });
        const turno = (await req("GET", api("/turnos/actual"), { token: tokCajero })).json.data;
        const c = await conLatte();
        const cobro = await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: { pagos: [{ metodo: "TARJETA", monto: 55 }] } });
        assert.equal(cobro.status, 200, JSON.stringify(cobro.json));
        const cierre = await req("POST", api(`/turnos/${turno.id}/cerrar`), { token: tokCajero, body: { efectivo_contado: 100 } });
        assert.equal(cierre.status, 200, JSON.stringify(cierre.json));

        const lista = (await req("GET", `/api/finanzas/${A}/ingresos?limit=50`)).json.data;
        const delCorte = lista.find((i) => i.pos_turno_id === turno.id);
        assert.ok(delCorte, "el listado identifica el ingreso del corte");

        const fecha = hoyISO(new Date(), ZONA);
        const editar = await req("PUT", `/api/finanzas/${A}/ingresos/${delCorte.id}`, { body: { fecha, metodo_pago: "TARJETA", monto: 1 } });
        assert.equal(editar.status, 409);
        assert.match(editar.json.error, /corte de caja/);
        const anular = await req("POST", `/api/finanzas/${A}/ingresos/${delCorte.id}/anular`, { body: { motivo: "prueba" } });
        assert.equal(anular.status, 409);
        assert.equal((await pool.query("SELECT monto::float AS monto, anulado FROM ingresos WHERE id = $1", [delCorte.id])).rows[0].monto, 55, "no cambió");

        const manual = await req("POST", `/api/finanzas/${A}/ingresos`, { body: { fecha, metodo_pago: "EFECTIVO", monto: 80 } });
        assert.equal(manual.status, 201);
        assert.equal((await req("PUT", `/api/finanzas/${A}/ingresos/${manual.json.data.id}`, { body: { fecha, metodo_pago: "EFECTIVO", monto: 90 } })).status, 200);
        assert.equal((await req("POST", `/api/finanzas/${A}/ingresos/${manual.json.data.id}/anular`, { body: { motivo: "prueba" } })).status, 200);
    });

    // ---------- 2. Serie de costo por día de negocio ----------
    it("la serie diaria de costo agrupa por el día de negocio de la empresa, no por la hora del servidor", async () => {
        // 2026-03-10 20:30 (hora del servidor) ya es 2026-03-11 en Kiritimati (UTC+14): ahí cae la venta.
        await pool.query(
            `INSERT INTO movimientosinventario (producto_id, tipo_movimiento, cantidad, costo_unitario, stock_anterior, stock_nuevo, fecha)
             VALUES ($1, 'VENTA', 5, 10, 100, 95, '2026-03-10 20:30:00')`, [harina],
        );
        const r = (await req("GET", `/api/finanzas/${A}/resumen?desde=2026-03-09&hasta=2026-03-12&agrupar=dia`)).json.data;
        const dia = (p) => r.serie.find((s) => s.periodo === p)?.costo_ventas ?? 0;
        const esperado = (await pool.query("SELECT to_char(fecha_negocio('2026-03-10 20:30:00'::timestamp, $1), 'YYYY-MM-DD') AS d", [ZONA])).rows[0].d;
        assert.notEqual(esperado, "2026-03-10", "el día de negocio de la empresa no es el de la hora del servidor");
        assert.equal(dia(esperado), 50, `el costo cae el ${esperado}`);
        const otros = r.serie.filter((s) => s.periodo !== esperado).reduce((n, s) => n + s.costo_ventas, 0);
        assert.equal(otros, 0, "ningún otro día lleva ese costo");
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id = $1 AND fecha = '2026-03-10 20:30:00'", [harina]);
    });

    // ---------- 3. Fechas por zona de la empresa ----------
    it("compra y conteo sin fecha usan el día de la empresa; una fecha futura se mide en su zona", async () => {
        const hoy = hoyISO(new Date(), ZONA);
        const compra = await req("POST", `/api/compras/${A}`, { body: { lineas: [{ producto_id: harina, cantidad: 1, costo_total: 10 }] } });
        assert.equal(compra.status, 201, JSON.stringify(compra.json));
        const fechaCompra = (await pool.query("SELECT to_char(fecha, 'YYYY-MM-DD') AS f FROM compra WHERE id = $1", [compra.json.data.compra.id])).rows[0].f;
        assert.equal(fechaCompra, hoy);

        const conteo = await req("POST", `/api/conteos/${A}`, { body: { lineas: [{ producto_id: harina, stock_fisico: await stock(harina) }] } });
        assert.equal(conteo.status, 201, JSON.stringify(conteo.json));
        const fechaConteo = (await pool.query("SELECT to_char(fecha, 'YYYY-MM-DD') AS f FROM conteo_fisico WHERE id = $1", [conteo.json.data.conteo.id])).rows[0].f;
        assert.equal(fechaConteo, hoy);

        assert.equal((await req("POST", `/api/finanzas/${A}/ingresos`, { body: { fecha: hoy, metodo_pago: "EFECTIVO", monto: 1 } })).status, 201, "hoy en su zona es válido aunque el servidor siga en ayer");
        const manana = new Date(Date.parse(hoy + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
        const futura = await req("POST", `/api/finanzas/${A}/ingresos`, { body: { fecha: manana, metodo_pago: "EFECTIVO", monto: 1 } });
        assert.equal(futura.status, 400);
        assert.match(futura.json.error, /futura/);
    });

    // ---------- 4. Conteo con base ----------
    it("conteo con base: lo vendido mientras se contaba no se confunde con un faltante o sobrante", async () => {
        const conteo = (lineas) => req("POST", `/api/conteos/${A}`, { body: { lineas } });

        // Contó 10 (el sistema tenía 10), pero se vendieron 2 antes de guardar: no hay diferencia y quedan 8.
        await fijarStock(leche, 8);
        const sinDiferencia = (await conteo([{ producto_id: leche, stock_fisico: 10, stock_teorico_base: 10 }])).json.data;
        assert.equal(sinDiferencia.detalle[0].variacion, 0);
        assert.equal(sinDiferencia.detalle[0].movimiento_durante_conteo, -2);
        assert.equal(await stock(leche), 8);

        // Faltaban 4 (contó 6 de 10) y mientras tanto se vendieron 3: lo real es 3.
        await fijarStock(leche, 7);
        const conFaltante = (await conteo([{ producto_id: leche, stock_fisico: 6, stock_teorico_base: 10 }])).json.data;
        assert.equal(conFaltante.detalle[0].variacion, -4);
        assert.equal(await stock(leche), 3);

        // Sin base se compara contra la existencia de ese momento, como siempre.
        await fijarStock(leche, 20);
        const clasico = (await conteo([{ producto_id: leche, stock_fisico: 18 }])).json.data;
        assert.equal(clasico.detalle[0].variacion, -2);
        assert.equal(await stock(leche), 18);

        // Si no había con qué cubrir lo vendido, el stock queda en negativo en vez de perderse el conteo.
        await fijarStock(leche, 7);
        const negativo = await conteo([{ producto_id: leche, stock_fisico: 0, stock_teorico_base: 10 }]);
        assert.equal(negativo.status, 201);
        assert.equal(await stock(leche), -3);

        // Anular el conteo deshace exactamente su ajuste.
        await req("POST", `/api/conteos/${A}/${negativo.json.data.conteo.id}/anular`, { body: { motivo: "prueba" } });
        assert.equal(await stock(leche), 7);
        await fijarStock(leche, 100);
    });

    // ---------- 5. Merma al cancelar lo ya enviado ----------
    it("cancelar un producto enviado: con «ya se preparó» registra merma; sin marcar no toca el inventario", async () => {
        await fijarStock(leche, 100);
        const sinMerma = await conLatte();
        const r1 = await req("POST", api(`/cuentas/${sinMerma.id}/items/${sinMerma.items[0].id}/cancelar`), { token: tokSupervisor, body: { motivo: "se arrepintió" } });
        assert.equal(r1.status, 200, JSON.stringify(r1.json));
        assert.equal(await stock(leche), 100);

        const conMerma = await conLatte(2);
        const r2 = await req("POST", api(`/cuentas/${conMerma.id}/items/${conMerma.items[0].id}/cancelar`), { token: tokSupervisor, body: { motivo: "se cayó", merma: true } });
        assert.equal(r2.status, 200, JSON.stringify(r2.json));
        assert.equal(await stock(leche), 98);
        assert.deepEqual(await movs(leche, "MERMA"), [{ cantidad: 2, referencia_tipo: "POS_MERMA" }]);
        const aut = (await pool.query("SELECT motivo FROM pos_autorizaciones WHERE cuenta_id = $1", [conMerma.id])).rows[0];
        assert.match(aut.motivo, /merma/);
        await req("POST", api(`/cuentas/${sinMerma.id}/cancelar`), { token: tokSupervisor, body: { motivo: "x" } });
        await req("POST", api(`/cuentas/${conMerma.id}/cancelar`), { token: tokSupervisor, body: { motivo: "x" } });
    });

    it("cancelar toda la cuenta con productos enviados: «ya se preparó» registra la merma de todo lo enviado", async () => {
        await fijarStock(leche, 100);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id = $1 AND tipo_movimiento = 'MERMA'", [leche]);
        const c = await conLatte(3);
        const r = await req("POST", api(`/cuentas/${c.id}/cancelar`), { token: tokSupervisor, body: { motivo: "se fueron", merma: true } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(await stock(leche), 97);
        assert.deepEqual(await movs(leche, "MERMA"), [{ cantidad: 3, referencia_tipo: "POS_MERMA" }]);

        // Una cuenta que cobra después no vuelve a descontar lo cancelado, y anularla no revierte la merma.
        const d = await conLatte(2);
        const extra = d.items[0];
        await req("POST", api(`/cuentas/${d.id}/items`), { token: tokMesero, body: { lineas: [{ tipo: "RECETA", id: latte, cantidad: 1, notas: "sin azúcar" }] } });
        await req("POST", api(`/cuentas/${d.id}/enviar`), { token: tokMesero });
        const detalle = (await req("GET", api(`/cuentas/${d.id}`), { token: tokMesero })).json.data;
        const aCancelar = detalle.items.find((i) => i.notas);
        await req("POST", api(`/cuentas/${d.id}/items/${aCancelar.id}/cancelar`), { token: tokSupervisor, body: { motivo: "error", merma: true } });
        assert.equal(extra.cantidad, 2);
        await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 0 } });
        const cobro = await req("POST", api(`/cuentas/${d.id}/cobrar`), { token: tokCajero, body: { pagos: [{ metodo: "TARJETA", monto: 110 }] } });
        assert.equal(cobro.status, 200, JSON.stringify(cobro.json));
        assert.equal(await stock(leche), 97 - 1 - 2, "merma de 1 + venta de 2");
        const anulada = await req("POST", api(`/cuentas/${d.id}/anular`), { token: tokSupervisor, body: { motivo: "prueba" } });
        assert.equal(anulada.status, 200, JSON.stringify(anulada.json));
        assert.equal(await stock(leche), 97 - 1, "se regresa la venta; la merma ya ocurrió");
    });

    // ---------- 6. Juntar cuentas ----------
    it("juntar cuentas continúa la numeración de comandas: no quedan dos «comanda 1»", async () => {
        const origen = await conLatte();
        const destino = await conLatte();
        await req("POST", api(`/cuentas/${destino.id}/items`), { token: tokMesero, body: { lineas: [{ tipo: "RECETA", id: latte, cantidad: 1, notas: "extra" }] } });
        await req("POST", api(`/cuentas/${destino.id}/enviar`), { token: tokMesero });
        const juntada = await req("POST", api(`/cuentas/${origen.id}/juntar`), { token: tokMesero, body: { destino_id: destino.id } });
        assert.equal(juntada.status, 200, JSON.stringify(juntada.json));
        const numeros = (await pool.query("SELECT numero FROM pos_comandas WHERE cuenta_id = $1 ORDER BY numero", [destino.id])).rows.map((r) => r.numero);
        assert.deepEqual(numeros, [1, 2, 3]);
        // Lo que se envíe después sigue la secuencia.
        await req("POST", api(`/cuentas/${destino.id}/items`), { token: tokMesero, body: { lineas: [{ tipo: "RECETA", id: latte, cantidad: 1, notas: "otra" }] } });
        await req("POST", api(`/cuentas/${destino.id}/enviar`), { token: tokMesero });
        const despues = (await pool.query("SELECT max(numero) AS n FROM pos_comandas WHERE cuenta_id = $1", [destino.id])).rows[0].n;
        assert.equal(despues, 4);
        await req("POST", api(`/cuentas/${destino.id}/cancelar`), { token: tokSupervisor, body: { motivo: "x" } });
    });

    // ---------- 7. Anular compra: el costo no vuelve a una compra ya anulada ----------
    it("anular la última compra restaura el costo de la compra vigente anterior, no el de una anulada", async () => {
        const costo = async () => Number((await pool.query("SELECT costo_unitario FROM productos WHERE id = $1", [harina])).rows[0].costo_unitario);
        const comprar = async (c) => (await req("POST", `/api/compras/${A}`, { body: { lineas: [{ producto_id: harina, cantidad: 1, costo_total: c }] } })).json.data.compra.id;
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id = $1 AND referencia_tipo = 'COMPRA'", [harina]);
        await pool.query("DELETE FROM compra WHERE empresa_id = $1", [A]);
        const a = await comprar(10);
        const b = await comprar(12);
        const c = await comprar(11);
        assert.equal(await costo(), 11);
        assert.equal((await req("POST", `/api/compras/${A}/${b}/anular`, { body: { motivo: "duplicada" } })).status, 200);
        assert.equal(await costo(), 11, "B no era la última: el costo no cambia");
        assert.equal((await req("POST", `/api/compras/${A}/${c}/anular`, { body: { motivo: "error" } })).status, 200);
        assert.equal(await costo(), 10, "vuelve al costo de A (B está anulada y no cuenta)");
        assert.ok(a);
    });

    // ---------- 8. Contraseñas y roles ----------
    it("las contraseñas nuevas piden al menos 8 caracteres", async () => {
        const nuevo = (password, n) => req("POST", `/api/usuarios/${A}`, { body: { nombre: `Pw ${n}`, codigo_ingreso: `PW-${n}`, email: `pw${n}@aud.test`, password } });
        assert.equal((await nuevo("abc1234", 1)).status, 400);
        assert.equal((await nuevo("abc12345", 2)).status, 201);
    });

    it("el rol Mesero ya no se anuncia como «próximamente»", async () => {
        const roles = (await pool.query("SELECT clave, nombre, descripcion FROM roles")).rows;
        const mesero = roles.find((r) => r.clave === "mesero");
        assert.equal(mesero.nombre, "Mesero");
        assert.ok(!/próximamente|Sin permisos/i.test(mesero.descripcion));
    });
});
