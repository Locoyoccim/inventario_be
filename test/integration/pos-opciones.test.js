import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Opciones por producto, comensal y tiempos: catálogo, validación al tomar la orden, cobro con consumo de insumos y envío por tiempos.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — opciones por producto, comensal y tiempos", { skip: SKIP }, () => {
    const A = 9751;
    const B = 9752;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor, tokAdminB;
    let mesas = [];
    let baguette, latte, queso, harina;
    let termino, extras;
    const mod = {}; // nombre -> id

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
    const api = (p, e = A) => `/api/pos/${e}${p}`;

    const limpiar = async () => {
        const e = [[A, B]];
        for (const t of ["pos_idempotencia", "pos_impresiones", "impresoras", "pos_autorizaciones", "pos_pagos", "pos_cuenta_items", "pos_comandas", "pos_cuentas", "pos_turnos", "pos_folios", "ingresos"]) {
            await pool.query(`DELETE FROM ${t} WHERE empresa_id = ANY($1)`, e);
        }
        await pool.query("DELETE FROM articulo_modificadores WHERE grupo_id IN (SELECT id FROM modificador_grupos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM modificadores WHERE grupo_id IN (SELECT id FROM modificador_grupos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM modificador_grupos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        for (const t of ["receta_detalle|receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", "recetas|empresa_id = ANY($1)", "inventario|empresa_id = ANY($1)", "productos|empresa_id = ANY($1)", "proveedores|empresa_id = ANY($1)",
            "categorias|empresa_id = ANY($1)", "mesas|empresa_id = ANY($1)", "areas_preparacion|empresa_id = ANY($1)", "usuarios|empresa_id = ANY($1)"]) {
            const [tabla, donde] = t.split("|");
            await pool.query(`DELETE FROM ${tabla} WHERE ${donde}`, e);
        }
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };
    const mkUsuario = async (empresa, codigo, { admin = false, rol = null } = {}) => {
        const rolId = rol ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id : null;
        const id = (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id,role_id) VALUES ($1,$1,$2,$2,$3,$4) RETURNING id", [codigo, admin, empresa, rolId])).rows[0].id;
        return signToken({ id, empresa_id: empresa, is_admin: admin, is_owner: admin, tv: 0 });
    };

    let siguiente = 0;
    const abrir = async () => (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesas[siguiente++ % mesas.length], personas: 4 } })).json.data;
    const agregar = (c, linea) => req("POST", api(`/cuentas/${c}/items`), { token: tokMesero, body: { lineas: [linea] } });
    const cuenta = async (c) => (await req("GET", api(`/cuentas/${c}`), { token: tokMesero })).json.data;
    const stock = async (p) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [p])).rows[0].stock_actual);
    const b = (extra = {}) => ({ tipo: "RECETA", id: baguette, cantidad: 1, opciones: [mod["Medio"]], ...extra });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Opciones'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n", [[A, B], ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "OP-adm", { admin: true });
        tokMesero = await mkUsuario(A, "OP-mes", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "OP-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "OP-sup", { rol: "supervisor" });
        tokAdminB = await mkUsuario(B, "OP-admB", { admin: true });
        for (let i = 1; i <= 30; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 6 } })).json.data.id);
        const prov = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const prod = async (producto, unidad_medida, costo, stock_actual) => (await req("POST", `/api/productos/${A}`, {
            body: { producto, categoria: "Insumo", unidad_medida, proveedor_id: prov, cantidad_presentacion: 1, costo_presentacion: costo, stock_minimo: 0, stock_actual },
        })).json.data.id;
        harina = await prod("Harina", "pz", 5, 1000);
        queso = await prod("Queso", "g", 0.2, 1000);
        const receta = async (nombre, categoria, precio, ingrediente) => (await req("POST", `/api/recetas/${A}`, { body: { nombre, categoria, precio_venta: precio, ingredientes: [{ producto_id: ingrediente, cantidad: 1 }] } })).json.data.id;
        baguette = await receta("Baguette", "Platillos", 120, harina);
        latte = await receta("Latte", "Bebidas", 58, harina);
        await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 0 } });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("el catálogo de opciones es de Admin y valida lo que se captura", async () => {
        const grupo = (nombre, extra = {}) => ({
            nombre, minimo: 1, maximo: 1, articulos: [{ tipo: "RECETA", id: baguette }],
            modificadores: [{ nombre: "Medio" }, { nombre: "Tres cuartos" }, { nombre: "Bien cocido" }], ...extra,
        });
        assert.equal((await req("POST", api("/opciones"), { token: tokMesero, body: grupo("Término") })).status, 403);
        assert.equal((await req("GET", api("/opciones"), { token: tokMesero })).status, 403);
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { minimo: 3, maximo: 1 }) })).status, 400, "mínimo mayor al máximo");
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { maximo: 5 }) })).status, 400, "máximo mayor al número de opciones");
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { modificadores: [{ nombre: "Igual" }, { nombre: "igual" }] }) })).status, 400, "opciones repetidas");
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { modificadores: [{ nombre: "Con insumo", producto_id: queso }] }) })).status, 400, "falta cuánto consume");
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { modificadores: [{ nombre: "Ajeno", producto_id: 999999, cantidad: 1 }] }) })).status, 400, "insumo inexistente");
        assert.equal((await req("POST", api("/opciones"), { body: grupo("X", { articulos: [{ tipo: "RECETA", id: 999999 }] }) })).status, 400, "receta inexistente");

        const t = await req("POST", api("/opciones"), { body: grupo("Término") });
        assert.equal(t.status, 201, JSON.stringify(t.json));
        termino = t.json.data.id;
        for (const m of t.json.data.modificadores) mod[m.nombre] = m.id;
        assert.equal((await req("POST", api("/opciones"), { body: grupo("término") })).status, 409, "nombre repetido");

        const e = await req("POST", api("/opciones"), {
            body: { nombre: "Extras", minimo: 0, maximo: 2, articulos: [{ tipo: "RECETA", id: baguette }], modificadores: [
                { nombre: "Extra queso", precio_extra: 15, producto_id: queso, cantidad: 30 }, { nombre: "Aguacate", precio_extra: 20 }, { nombre: "Tocino", precio_extra: 18 },
            ] },
        });
        assert.equal(e.status, 201, JSON.stringify(e.json));
        extras = e.json.data.id;
        for (const m of e.json.data.modificadores) mod[m.nombre] = m.id;
        assert.equal(e.json.data.modificadores[0].producto, "Queso");
        assert.deepEqual(e.json.data.articulos, [{ tipo: "RECETA", id: baguette }]);
        // Otra empresa no ve ni toca estos grupos.
        assert.equal((await req("GET", api("/opciones", B), { token: tokAdminB })).json.data.grupos.length, 0);
        assert.equal((await req("PUT", api(`/opciones/${termino}`, B), { token: tokAdminB, body: grupo("Robado") })).status, 404);
    });

    it("el menú trae sus grupos y a qué artículos se ofrecen", async () => {
        const menu = (await req("GET", api("/menu"), { token: tokMesero })).json.data;
        const bag = menu.articulos.find((a) => a.id === baguette);
        assert.deepEqual(bag.grupos.sort(), [termino, extras].sort());
        assert.deepEqual(menu.articulos.find((a) => a.id === latte).grupos, []);
        const g = menu.grupos.find((x) => x.id === extras);
        assert.deepEqual([g.minimo, g.maximo, g.modificadores.length], [0, 2, 3]);
        assert.equal(g.modificadores[0].precio_extra, 15);
        assert.equal("producto_id" in g.modificadores[0], false, "el mesero no necesita saber qué insumo consume");
    });

    it("al tomar la orden se exige lo obligatorio, se rechaza lo que no corresponde y el renglón guarda su copia con el precio con extras", async () => {
        const c = await abrir();
        const sin = await agregar(c.id, { tipo: "RECETA", id: baguette, cantidad: 1 });
        assert.equal(sin.status, 400);
        assert.match(sin.json.error, /Elige una opción de «Término»/);
        assert.equal((await agregar(c.id, b({ opciones: [mod["Medio"], mod["Bien cocido"]] }))).status, 400, "dos términos");
        assert.equal((await agregar(c.id, b({ opciones: [mod["Medio"], mod["Extra queso"], mod["Aguacate"], mod["Tocino"]] }))).status, 400, "demasiados extras");
        assert.equal((await agregar(c.id, b({ opciones: [mod["Medio"], 999999] }))).status, 400, "opción inexistente");
        assert.equal((await agregar(c.id, { tipo: "RECETA", id: latte, cantidad: 1, opciones: [mod["Medio"]] })).status, 400, "el latte no ofrece esas opciones");
        assert.equal((await cuenta(c.id)).items.length, 0, "nada quedó a medias");

        const ok = await agregar(c.id, b({ opciones: [mod["Medio"], mod["Extra queso"], mod["Aguacate"]], comensal: 2, tiempo: 1 }));
        assert.equal(ok.status, 201, JSON.stringify(ok.json));
        const item = ok.json.data.items[0];
        assert.equal(Number(item.precio_unitario), 155, "120 + 15 + 20");
        assert.deepEqual(item.opciones.map((o) => o.nombre), ["Medio", "Extra queso", "Aguacate"]);
        assert.equal(item.opciones[1].producto_id, queso);
        assert.equal(item.comensal, 2);
        assert.equal(ok.json.data.totales.total, 155);
        // Un artículo sin grupos no necesita ni admite opciones.
        assert.equal((await agregar(c.id, { tipo: "RECETA", id: latte, cantidad: 1 })).status, 201);
    });

    it("renglones iguales (mismas opciones, comensal y tiempo) se suman; si algo cambia, van aparte", async () => {
        const c = await abrir();
        await agregar(c.id, b());
        await agregar(c.id, b());
        assert.deepEqual((await cuenta(c.id)).items.map((i) => i.cantidad), [2], "mismas opciones: se suman");
        await agregar(c.id, b({ opciones: [mod["Bien cocido"]] }));
        await agregar(c.id, b({ comensal: 3 }));
        await agregar(c.id, b({ tiempo: 2 }));
        await agregar(c.id, b({ opciones: [mod["Medio"], mod["Tocino"]] }));
        assert.equal((await cuenta(c.id)).items.length, 5);
        await agregar(c.id, b({ comensal: 3 }));
        const items = (await cuenta(c.id)).items;
        assert.equal(items.length, 5);
        assert.equal(items.find((i) => i.comensal === 3).cantidad, 2);
    });

    it("el catálogo puede cambiar sin alterar lo ya tomado, y lo que se desactiva deja de ofrecerse", async () => {
        const c = await abrir();
        await agregar(c.id, b({ opciones: [mod["Medio"], mod["Aguacate"]] }));
        // Sube el precio del aguacate y cambia el nombre: la cuenta conserva su copia.
        const grupos = (await req("GET", api("/opciones"))).json.data.grupos;
        const g = grupos.find((x) => x.id === extras);
        const cambiado = g.modificadores.map((m) => (m.nombre === "Aguacate" ? { ...m, nombre: "Aguacate hass", precio_extra: 35 } : m));
        const r = await req("PUT", api(`/opciones/${extras}`), { body: { nombre: "Extras", minimo: 0, maximo: 2, articulos: g.articulos, modificadores: cambiado } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const item = (await cuenta(c.id)).items[0];
        assert.equal(Number(item.precio_unitario), 140);
        assert.equal(item.opciones[1].nombre, "Aguacate");
        // Lo nuevo ya usa el precio nuevo.
        const nuevo = (await agregar(c.id, b({ opciones: [mod["Medio"], mod["Aguacate"]], comensal: 9 }))).json.data.items.find((i) => i.comensal === 9);
        assert.equal(Number(nuevo.precio_unitario), 155);
        assert.equal(nuevo.opciones[1].nombre, "Aguacate hass");
        // Quitar una opción del grupo la desactiva (no se borra).
        const sinTocino = r.json.data.modificadores.filter((m) => m.nombre !== "Tocino");
        await req("PUT", api(`/opciones/${extras}`), { body: { nombre: "Extras", minimo: 0, maximo: 2, articulos: g.articulos, modificadores: sinTocino } });
        assert.equal((await agregar(c.id, b({ opciones: [mod["Medio"], mod["Tocino"]], comensal: 8 }))).status, 400);
        assert.equal((await pool.query("SELECT activo FROM modificadores WHERE id = $1", [mod["Tocino"]])).rows[0].activo, false);
    });

    it("cobrar suma los extras al total y descuenta el insumo de las opciones por pieza; anular lo regresa", async () => {
        const c = await abrir();
        await agregar(c.id, b({ opciones: [mod["Medio"], mod["Extra queso"]], cantidad: 2 }));
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        const antesQueso = await stock(queso);
        const antesHarina = await stock(harina);
        const cobro = await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: { pagos: [{ metodo: "TARJETA", monto: 270 }] } });
        assert.equal(cobro.status, 200, JSON.stringify(cobro.json));
        assert.equal(await stock(queso), antesQueso - 60, "2 piezas × 30 g");
        assert.equal(await stock(harina), antesHarina - 2, "y el ingrediente de la receta");
        const mov = (await pool.query("SELECT cantidad::float AS c, tipo_movimiento, referencia_tipo FROM movimientosinventario WHERE producto_id = $1 ORDER BY id DESC LIMIT 1", [queso])).rows[0];
        assert.deepEqual([mov.c, mov.tipo_movimiento, mov.referencia_tipo], [60, "VENTA", "POS_CUENTA"]);
        const anulada = await req("POST", api(`/cuentas/${c.id}/anular`), { token: tokSupervisor, body: { motivo: "prueba" } });
        assert.equal(anulada.status, 200, JSON.stringify(anulada.json));
        assert.equal(await stock(queso), antesQueso, "el insumo de la opción también regresa");
    });

    it("cancelar con merma incluye el insumo de las opciones", async () => {
        const c = await abrir();
        await agregar(c.id, b({ opciones: [mod["Medio"], mod["Extra queso"]], cantidad: 1 }));
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        const antes = await stock(queso);
        const item = (await cuenta(c.id)).items[0];
        const r = await req("POST", api(`/cuentas/${c.id}/items/${item.id}/cancelar`), { token: tokSupervisor, body: { motivo: "se cayó", merma: true } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(await stock(queso), antes - 30);
        const mov = (await pool.query("SELECT tipo_movimiento, referencia_tipo FROM movimientosinventario WHERE producto_id = $1 ORDER BY id DESC LIMIT 1", [queso])).rows[0];
        assert.deepEqual([mov.tipo_movimiento, mov.referencia_tipo], ["MERMA", "POS_MERMA"]);
    });

    it("dividir conserva opciones, comensal y tiempo, y los totales cuadran", async () => {
        const c = await abrir();
        await agregar(c.id, b({ opciones: [mod["Medio"], mod["Aguacate"]], cantidad: 3, comensal: 2 }));
        await agregar(c.id, { tipo: "RECETA", id: latte, cantidad: 1 });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        const original = await cuenta(c.id);
        const totalAntes = original.totales.total;
        const item = original.items.find((i) => i.opciones.length > 0);
        const r = await req("POST", api(`/cuentas/${c.id}/dividir`), { token: tokMesero, body: { partes: [{ item_id: item.id, cantidad: 1 }] } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const movido = r.json.data.nueva.items[0];
        assert.deepEqual(movido.opciones.map((o) => o.nombre), ["Medio", "Aguacate hass"]);
        assert.equal(movido.comensal, 2);
        assert.equal(movido.cantidad, 1);
        assert.equal(Number((r.json.data.nueva.totales.total + r.json.data.origen.totales.total).toFixed(2)), totalAntes);
    });

    it("tiempos: «enviar» manda el primero; el segundo se dispara aparte y cobrar espera a que no quede nada pendiente", async () => {
        const c = await abrir();
        await agregar(c.id, { tipo: "RECETA", id: latte, cantidad: 1, tiempo: 1 });
        await agregar(c.id, b({ tiempo: 2, comensal: 1 }));
        const primero = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        assert.equal(primero.status, 200, JSON.stringify(primero.json));
        assert.equal(primero.json.data.comandas.length, 1, "solo lo del primer tiempo");
        assert.equal((await pool.query("SELECT payload->>'tiempo' AS t FROM pos_impresiones WHERE tipo = 'COMANDA' AND referencia_id = $1", [primero.json.data.comandas[0].id])).rows[0].t, "1");
        let estado = await cuenta(c.id);
        assert.deepEqual(estado.items.map((i) => [i.nombre, i.estado, i.tiempo]), [["Latte", "ENVIADO", 1], ["Baguette", "PENDIENTE", 2]]);

        const repetido = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        assert.equal(repetido.status, 400);
        assert.match(repetido.json.error, /1\.º tiempo/);
        const cobrarYa = await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: { pagos: [{ metodo: "TARJETA", monto: 178 }] } });
        assert.equal(cobrarYa.status, 400, "hay un tiempo sin enviar");

        const segundo = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, body: { tiempo: 2 } });
        assert.equal(segundo.status, 200, JSON.stringify(segundo.json));
        const payload = (await pool.query("SELECT payload FROM pos_impresiones WHERE tipo = 'COMANDA' AND referencia_id = $1", [segundo.json.data.comandas[0].id])).rows[0].payload;
        assert.equal(payload.tiempo, 2);
        assert.deepEqual(payload.items, [{ cantidad: 1, nombre: "Baguette", notas: null, opciones: ["Medio"], comensal: 1 }]);
        estado = await cuenta(c.id);
        assert.equal(estado.items.every((i) => i.estado === "ENVIADO"), true);
        assert.equal((await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, body: { tiempo: 9 } })).status, 400, "tiempo fuera de rango");
    });

    it("comensal y tiempo se pueden corregir mientras el renglón está pendiente", async () => {
        const c = await abrir();
        const item = (await agregar(c.id, b())).json.data.items[0];
        const r = await req("PUT", api(`/cuentas/${c.id}/items/${item.id}`), { token: tokMesero, body: { comensal: 4, tiempo: 3 } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual([r.json.data.items[0].comensal, r.json.data.items[0].tiempo], [4, 3]);
        const quitar = await req("PUT", api(`/cuentas/${c.id}/items/${item.id}`), { token: tokMesero, body: { comensal: null } });
        assert.equal(quitar.json.data.items[0].comensal, null);
        assert.equal(quitar.json.data.items[0].tiempo, 3, "lo que no se menciona no cambia");
    });

    it("la pantalla de cocina recibe las opciones, el comensal y el tiempo de cada comanda", async () => {
        await req("PUT", `/api/empresas/${A}/configuracion`, { body: { usa_pantalla_cocina: true } });
        const areas = (await req("GET", api("/areas"))).json.data;
        for (const a of areas.filter((x) => x.nombre === "Cocina")) await req("PUT", api(`/areas/${a.id}`), { body: { pantalla: true } });
        const c = await abrir();
        await agregar(c.id, b({ opciones: [mod["Bien cocido"], mod["Extra queso"]], comensal: 2, tiempo: 2 }));
        const env = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, body: { tiempo: 2 } });
        assert.equal(env.status, 200, JSON.stringify(env.json));
        const activas = (await req("GET", api("/comandas/activas"))).json.data;
        const k = activas.find((x) => x.id === env.json.data.comandas[0].id);
        assert.equal(k.tiempo, 2);
        assert.deepEqual(k.renglones[0].opciones, ["Bien cocido", "Extra queso"]);
        assert.equal(k.renglones[0].comensal, 2);
        await req("PUT", `/api/empresas/${A}/configuracion`, { body: { usa_pantalla_cocina: false } });
    });

    it("desactivar un grupo deja de ofrecerlo y no rompe las cuentas abiertas", async () => {
        const c = await abrir();
        await agregar(c.id, b());
        assert.equal((await req("DELETE", api(`/opciones/${termino}`))).status, 200);
        assert.equal((await req("DELETE", api(`/opciones/${termino}`))).status, 404);
        assert.equal((await cuenta(c.id)).items[0].opciones[0].nombre, "Medio", "la cuenta abierta conserva su copia");
        const sinGrupo = await agregar(c.id, { tipo: "RECETA", id: baguette, cantidad: 1 });
        assert.equal(sinGrupo.status, 201, "sin el grupo obligatorio, el artículo se puede pedir sin elegir término");
        const menu = (await req("GET", api("/menu"), { token: tokMesero })).json.data;
        assert.equal(menu.grupos.some((g) => g.id === termino), false);
    });
});
