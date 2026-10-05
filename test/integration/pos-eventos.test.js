import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Avisos en tiempo real del POS: Postgres NOTIFY -> SSE. Los eventos son avisos con ids; salen al confirmar, no en rollback.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — avisos en tiempo real (SSE)", { skip: SKIP }, () => {
    const A = 9741;
    const B = 9742;
    let server, base, pool, signToken, cerrarEventos, reiniciarEventos;
    let tokAdmin, tokMesero, tokCocina, tokSupervisor, tokFinanzas, tokMeseroB;
    let mesas = [];
    let latte, baguette;
    const abiertos = [];

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

    // Lector del flujo SSE: junta los eventos `data:` que llegan.
    async function flujo(token, empresa = A) {
        const control = new AbortController();
        const res = await fetch(base + api("/eventos", empresa), { headers: { Authorization: `Bearer ${token}` }, signal: control.signal });
        const salida = { status: res.status, eventos: [], cabeceras: res.headers, terminado: false };
        if (res.status !== 200) {
            await res.body?.cancel();
            return salida;
        }
        const lector = res.body.getReader();
        const decodificador = new TextDecoder();
        let resto = "";
        (async () => {
            try {
                for (;;) {
                    const { done, value } = await lector.read();
                    if (done) break;
                    resto += decodificador.decode(value, { stream: true });
                    let i;
                    while ((i = resto.indexOf("\n\n")) >= 0) {
                        const bloque = resto.slice(0, i);
                        resto = resto.slice(i + 2);
                        const linea = bloque.split("\n").find((l) => l.startsWith("data: "));
                        if (linea) salida.eventos.push(JSON.parse(linea.slice(6)));
                    }
                }
            } catch { /* abortado */ }
            salida.terminado = true;
        })();
        salida.cerrar = () => control.abort();
        abiertos.push(salida);
        return salida;
    }
    const esperar = async (f, pred, ms = 3000) => {
        const hasta = Date.now() + ms;
        while (Date.now() < hasta) {
            const e = f.eventos.find(pred);
            if (e) return e;
            await new Promise((r) => setTimeout(r, 25));
        }
        return null;
    };
    const quieto = (ms = 350) => new Promise((r) => setTimeout(r, ms));

    const limpiar = async () => {
        const e = [[A, B]];
        for (const t of ["pos_idempotencia", "pos_impresiones", "impresoras", "pos_autorizaciones", "pos_pagos", "pos_cuenta_items", "pos_comandas", "pos_cuentas", "pos_turnos", "pos_folios"]) {
            await pool.query(`DELETE FROM ${t} WHERE empresa_id = ANY($1)`, e);
        }
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
    const abrir = async () => (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesas[siguiente++ % mesas.length], personas: 2 } })).json.data;
    const agregar = (c, ...ids) => req("POST", api(`/cuentas/${c}/items`), { token: tokMesero, body: { lineas: ids.map((id) => ({ tipo: "RECETA", id, cantidad: 1 })) } });
    const enviar = (c) => req("POST", api(`/cuentas/${c}/enviar`), { token: tokMesero });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ cerrarEventos, reiniciarEventos } = await import("../../src/realtime/eventosPos.js"));
        reiniciarEventos();
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Eventos'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n", [[A, B], ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "EV-adm", { admin: true });
        tokMesero = await mkUsuario(A, "EV-mes", { rol: "mesero" });
        tokCocina = await mkUsuario(A, "EV-coc", { rol: "cocina" });
        tokSupervisor = await mkUsuario(A, "EV-sup", { rol: "supervisor" });
        tokFinanzas = await mkUsuario(A, "EV-fin", { rol: "finanzas" });
        tokMeseroB = await mkUsuario(B, "EV-mesB", { rol: "mesero" });
        for (let i = 1; i <= 12; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);
        const areas = (await req("GET", api("/areas"))).json.data;
        const prov = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const insumo = (await req("POST", `/api/productos/${A}`, { body: { producto: "Insumo", categoria: "Insumo", unidad_medida: "pz", proveedor_id: prov, cantidad_presentacion: 1, costo_presentacion: 5, stock_minimo: 0, stock_actual: 500 } })).json.data.id;
        const receta = async (nombre, categoria, precio, area) => {
            const id = (await req("POST", `/api/recetas/${A}`, { body: { nombre, categoria, precio_venta: precio, ingredientes: [{ producto_id: insumo, cantidad: 1 }] } })).json.data.id;
            await req("PUT", api(`/asignacion-areas/receta/${id}`), { body: { area_id: area } });
            return id;
        };
        latte = await receta("Latte", "Bebidas", 58, areas.find((a) => a.nombre === "Barra").id);
        baguette = await receta("Baguette", "Platillos", 120, areas.find((a) => a.nombre === "Cocina").id);
        await req("PUT", `/api/empresas/${A}/configuracion`, { body: { usa_pantalla_cocina: true } });
        for (const nombre of ["Barra", "Cocina"]) await req("PUT", api(`/areas/${areas.find((a) => a.nombre === nombre).id}`), { body: { pantalla: true } });
    });

    after(async () => {
        for (const f of abiertos) f.cerrar?.();
        await cerrarEventos();
        await limpiar();
        await pool.end();
        server.close();
    });

    it("hace falta sesión y el permiso de ver el POS", async () => {
        assert.equal((await fetch(base + api("/eventos"))).status, 401);
        assert.equal((await flujo(tokFinanzas)).status, 403, "un rol sin pos.ver no recibe avisos");
        assert.equal((await flujo(tokAdminB(), A)).status, 403, "otra empresa no escucha esta");
    });
    const tokAdminB = () => tokMeseroB;

    it("al conectar avisa que quedó conectado y manda las cabeceras de un flujo sin acumular", async () => {
        const f = await flujo(tokMesero);
        assert.equal(f.status, 200);
        assert.match(f.cabeceras.get("content-type"), /text\/event-stream/);
        assert.match(f.cabeceras.get("cache-control"), /no-transform/);
        assert.equal(f.cabeceras.get("x-accel-buffering"), "no");
        assert.ok(await esperar(f, (e) => e.tipo === "conectado"));
    });

    it("enviar avisa a las pantallas y al mesero de ESA empresa, con ids y sin datos; otra empresa no se entera", async () => {
        const mesero = await flujo(tokMesero);
        const cocina = await flujo(tokCocina);
        const otra = await flujo(tokMeseroB, B);
        await esperar(mesero, (e) => e.tipo === "conectado");
        await esperar(otra, (e) => e.tipo === "conectado");
        const c = await abrir();
        await agregar(c.id, latte, baguette);
        await quieto(100);
        assert.equal(mesero.eventos.some((e) => e.tipo === "comanda.nueva"), false, "agregar renglones no avisa (solo al enviar)");
        const r = await enviar(c.id);
        assert.equal(r.status, 200);
        const e = await esperar(cocina, (x) => x.tipo === "comanda.nueva");
        assert.ok(e);
        assert.equal(e.cuenta_id, c.id);
        assert.equal(e.empresa_id, A);
        assert.equal(e.areas.length, 2);
        assert.ok(e.mesero_id);
        assert.deepEqual(Object.keys(e).sort(), ["areas", "cuenta_id", "empresa_id", "mesero_id", "tipo"], "solo ids: nada de nombres ni precios");
        assert.ok(await esperar(mesero, (x) => x.tipo === "comanda.nueva"));
        await quieto();
        assert.equal(otra.eventos.some((x) => x.tipo === "comanda.nueva"), false, "la otra empresa no recibe nada");
    });

    it("un envío que falla (rollback o sin nada que enviar) no avisa", async () => {
        const f = await flujo(tokCocina);
        await esperar(f, (e) => e.tipo === "conectado");
        const c = await abrir();
        assert.equal((await enviar(c.id)).status, 400);
        await quieto();
        assert.equal(f.eventos.some((e) => e.tipo === "comanda.nueva"), false);
    });

    it("cambiar el estado de una comanda avisa con su estado; repetirlo no vuelve a avisar", async () => {
        const f = await flujo(tokMesero);
        await esperar(f, (e) => e.tipo === "conectado");
        const c = await abrir();
        await agregar(c.id, latte);
        const comanda = (await enviar(c.id)).json.data.comandas[0];
        const listo = await req("POST", api(`/comandas/${comanda.id}/estado`), { token: tokCocina, body: { estado: "LISTA" } });
        assert.equal(listo.status, 200);
        const e = await esperar(f, (x) => x.tipo === "comanda.estado" && x.estado === "LISTA");
        assert.ok(e);
        assert.equal(e.comanda_id, comanda.id);
        assert.equal(e.cuenta_id, c.id);
        assert.ok(e.mesero_id, "el mesero sabe que es de su cuenta");
        const antes = f.eventos.filter((x) => x.tipo === "comanda.estado").length;
        await req("POST", api(`/comandas/${comanda.id}/estado`), { token: tokCocina, body: { estado: "LISTA" } });
        await quieto();
        assert.equal(f.eventos.filter((x) => x.tipo === "comanda.estado").length, antes);
    });

    it("cancelar lo ya enviado avisa a la cocina", async () => {
        const f = await flujo(tokCocina);
        await esperar(f, (e) => e.tipo === "conectado");
        const c = await abrir();
        await agregar(c.id, latte);
        await enviar(c.id);
        const item = (await req("GET", api(`/cuentas/${c.id}`), { token: tokMesero })).json.data.items[0];
        const r = await req("POST", api(`/cuentas/${c.id}/items/${item.id}/cancelar`), { token: tokSupervisor, body: { motivo: "prueba" } });
        assert.equal(r.status, 200);
        assert.ok(await esperar(f, (e) => e.tipo === "comanda.cancelada" && e.cuenta_id === c.id));
    });

    it("apagar o encender la pantalla de cocina avisa para que los equipos refresquen su menú", async () => {
        const f = await flujo(tokMesero);
        await esperar(f, (e) => e.tipo === "conectado");
        await req("PUT", `/api/empresas/${A}/configuracion`, { body: { usa_pantalla_cocina: true } });
        assert.ok(await esperar(f, (e) => e.tipo === "config"));
    });

    it("si la escucha de la base se cae, se reconecta sola y manda «resync» para que todos refresquen; los avisos siguen llegando", async () => {
        const f = await flujo(tokMesero);
        await esperar(f, (e) => e.tipo === "conectado");
        const matados = await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN pos_eventos%' AND pid <> pg_backend_pid()");
        assert.ok(matados.rowCount >= 1, "había una escucha abierta");
        assert.ok(await esperar(f, (e) => e.tipo === "resync", 8000), "tras reconectar, todos refrescan");
        const c = await abrir();
        await agregar(c.id, latte);
        await enviar(c.id);
        assert.ok(await esperar(f, (e) => e.tipo === "comanda.nueva" && e.cuenta_id === c.id), "los avisos vuelven a llegar");
    });

    it("al apagar el servidor los flujos se cierran (no dejan colgado el cierre)", async () => {
        const f = await flujo(tokSupervisor);
        await esperar(f, (e) => e.tipo === "conectado");
        await cerrarEventos();
        assert.ok(await esperar(f, (e) => e.tipo === "cierre"));
        const hasta = Date.now() + 2000;
        while (!f.terminado && Date.now() < hasta) await quieto(25);
        assert.equal(f.terminado, true);
    });
});
