import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — POS: mesas, cuentas, comandas e impresión", { skip: SKIP }, () => {
    const A = 9411;
    const B = 9412;
    let server, base, pool, signToken, reiniciarPurga;
    let tokAdmin, tokMesero, tokCajero, tokSupervisor, tokHostess, tokAdminB;
    let m1, m2, m3, barra, sinComanda;
    let latte, baguette, pellegrino;
    const est = {};
    const PRECIO_LATTE = 99; // el test de "precio congelado" sube el Latte de 55 a 99

    const req = async (method, path, { token, body, headers } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
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
        await pool.query("DELETE FROM agentes_impresion WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_cuenta_items WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM pos_comandas WHERE empresa_id = ANY($1)", e);
        await pool.query("UPDATE pos_cuentas SET unida_a = NULL, dividida_de = NULL WHERE empresa_id = ANY($1)", e);
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
    const abrir = async (mesa, token = tokMesero) => (await req("POST", api("/cuentas"), { token, body: { tipo: "MESA", mesa_id: mesa, personas: 2 } })).json.data;
    const agregar = async (cuenta, lineas, token = tokMesero) => (await req("POST", api(`/cuentas/${cuenta}/items`), { token, body: { lineas } })).json.data;
    const linea = (a, cantidad = 1, notas) => ({ tipo: a.tipo, id: a.id, cantidad, ...(notas ? { notas } : {}) });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ reiniciarPurga } = await import("../../src/modules/pos/pos.cuentas.repository.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Café Test'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "OP-adm", { admin: true });
        tokMesero = await mkUsuario(A, "OP-mes", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "OP-caj", { rol: "cajero" });
        tokSupervisor = await mkUsuario(A, "OP-sup", { rol: "supervisor" });
        tokHostess = await mkUsuario(A, "OP-hos", { rol: "hostess" });
        tokAdminB = await mkUsuario(B, "OP-admB", { admin: true });

        const areas = (await req("GET", api("/areas"), { token: tokAdmin })).json.data;
        const idArea = (n) => areas.find((a) => a.nombre === n).id;
        [barra, sinComanda] = [idArea("Barra"), idArea("Sin comanda")];
        const bebidas = (await req("GET", api("/asignacion-areas"), { token: tokAdmin })).json.data.find((c) => c.nombre === "Bebidas");
        await req("PUT", api(`/asignacion-areas/categoria/${bebidas.id}`), { token: tokAdmin, body: { area_id: barra } });

        for (const nombre of ["Mesa 1", "Mesa 2", "Mesa 3"]) {
            const r = await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre, capacidad: 4 } });
            if (nombre === "Mesa 1") m1 = r.json.data.id;
            if (nombre === "Mesa 2") m2 = r.json.data.id;
            if (nombre === "Mesa 3") m3 = r.json.data.id;
        }

        const provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        const leche = (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin, body: { producto: "Leche", unidad_medida: "pz", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1, costo_presentacion: 10, stock_actual: 10, stock_minimo: 0 },
        })).json.data.id;
        const pel = (await req("POST", `/api/productos/${A}`, {
            token: tokAdmin, body: { producto: "Pellegrino", unidad_medida: "pz", proveedor_id: provId, categoria: "Bebidas", cantidad_presentacion: 1, costo_presentacion: 20, stock_actual: 10, stock_minimo: 0, precio_venta: 45 },
        })).json.data.id;
        await req("PUT", api(`/asignacion-areas/producto/${pel}`), { token: tokAdmin, body: { area_id: sinComanda } });
        const mkReceta = async (b) => (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body: { ...b, ingredientes: [{ producto_id: leche, cantidad: 1 }] } })).json.data.id;
        const l = await mkReceta({ nombre: "Latte", categoria: "Bebidas", precio_venta: 55 });
        const b = await mkReceta({ nombre: "Baguette", categoria: "Platillos", precio_venta: 120 });
        latte = { tipo: "RECETA", id: l };
        baguette = { tipo: "RECETA", id: b };
        pellegrino = { tipo: "PRODUCTO", id: pel };
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("abrir mesa: mesero abre, la misma mesa no se abre dos veces (ni en paralelo) y hostess no puede", async () => {
        const paralelo = await Promise.all([abrir(m3), abrir(m3), abrir(m3)].map((p) => p.catch(() => null)));
        const exitos = paralelo.filter((c) => c && c.id);
        const conflictos = await Promise.all([1, 2].map(() => req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: m3 } })));
        assert.equal(exitos.length, 1, "solo una de las aperturas simultáneas gana");
        assert.ok(conflictos.every((r) => r.status === 409));
        assert.match(conflictos[0].json.error, /ya tiene una cuenta abierta/);
        const libre = (await req("POST", api("/cuentas"), { token: tokHostess, body: { tipo: "MESA", mesa_id: m2 } }));
        assert.equal(libre.status, 403);
        assert.equal(exitos[0].estado, "ABIERTA");
        assert.equal(exitos[0].folio >= 1, true);
        await req("POST", api(`/cuentas/${exitos[0].id}/cancelar`), { token: tokMesero, body: {} });
    });

    it("productos: solo del menú, con precio e IVA congelados; editar y quitar mientras están pendientes", async () => {
        const c = await abrir(m1);
        const fuera = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: { lineas: [{ tipo: "RECETA", id: 999999, cantidad: 1 }] } });
        assert.equal(fuera.status, 400);

        const cuenta = await agregar(c.id, [linea(latte, 2, "sin azúcar"), linea(baguette), linea(pellegrino)]);
        assert.equal(cuenta.items.length, 3);
        assert.equal(cuenta.totales.total, 2 * 55 + 120 + 45);
        const itemLatte = cuenta.items.find((i) => i.nombre === "Latte");
        assert.equal(itemLatte.notas, "sin azúcar");
        assert.equal(itemLatte.area_id, barra);

        // Cambiar el precio después no altera el renglón ya agregado.
        await req("PUT", `/api/recetas/${A}/${latte.id}`, { token: tokAdmin, body: { nombre: "Latte", categoria: "Bebidas", precio_venta: 99, ingredientes: undefined, activo: true } });
        const reabierta = (await req("GET", api(`/cuentas/${c.id}`), { token: tokMesero })).json.data;
        assert.equal(reabierta.items.find((i) => i.nombre === "Latte").precio_unitario, "55.00");

        const upd = await req("PUT", api(`/cuentas/${c.id}/items/${itemLatte.id}`), { token: tokMesero, body: { cantidad: 3, notas: "" } });
        assert.equal(upd.json.data.items.find((i) => i.id === itemLatte.id).cantidad, 3);
        assert.equal(upd.json.data.items.find((i) => i.id === itemLatte.id).notas, null);
        const del = await req("DELETE", api(`/cuentas/${c.id}/items/${cuenta.items.find((i) => i.nombre === "Pellegrino").id}`), { token: tokMesero });
        assert.equal(del.json.data.items.length, 2);
        est.cuentaFlujo = c.id;
    });

    it("enviar: una comanda por área (bebidas a Barra, alimentos a Cocina); 'Sin comanda' no imprime; sin impresora queda en SIN_IMPRESORA", async () => {
        const c = (await req("GET", api("/cuentas/" + est.cuentaFlujo), { token: tokMesero })).json.data;
        await agregar(c.id, [linea(pellegrino)]);
        const env = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        assert.equal(env.status, 200);
        const { comandas, sin_comanda, cuenta } = env.json.data;
        assert.deepEqual(comandas.map((x) => [x.area, x.renglones]).sort(), [["Barra", 1], ["Cocina", 1]]);
        assert.equal(sin_comanda, 1);
        assert.ok(comandas.every((x) => x.impresion_estado === "SIN_IMPRESORA"));
        assert.ok(cuenta.items.every((i) => i.estado === "ENVIADO"));
        assert.equal(cuenta.items.filter((i) => i.comanda_id).length, 2);

        assert.equal((await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero })).status, 400, "ya no hay nada por enviar");
        const cola = (await req("GET", api("/impresiones?estado=SIN_IMPRESORA"), { token: tokSupervisor })).json.data;
        assert.ok(cola.some((j) => j.error?.includes("Sin impresora configurada")));
    });

    it("sin impresora: el trabajo se obtiene y se marca impreso desde el navegador (una sola vez)", async () => {
        const cola = (await req("GET", api("/impresiones?estado=SIN_IMPRESORA"), { token: tokSupervisor })).json.data;
        const job = cola.find((j) => j.tipo === "COMANDA");
        assert.ok(job, "hay una comanda sin impresora");
        const det = await req("GET", api(`/impresiones/${job.id}`), { token: tokMesero });
        assert.equal(det.status, 200);
        assert.equal(det.json.data.payload.tipo, "COMANDA");
        const est = (await req("GET", api("/impresion/estado"), { token: tokMesero })).json.data;
        assert.ok(est.sin_impresora >= 1, "el estado cuenta los trabajos sin impresora");
        const ok = await req("POST", api(`/impresiones/${job.id}/impreso-navegador`), { token: tokMesero });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.data.estado, "IMPRESO");
        assert.equal((await req("POST", api(`/impresiones/${job.id}/impreso-navegador`), { token: tokMesero })).status, 409, "ya impreso");
        assert.equal((await req("GET", api("/impresiones/99999999"), { token: tokMesero })).status, 404);
    });

    it("el contenido de la comanda lleva mesa, mesero, número y notas, sin precios", async () => {
        const job = (await pool.query("SELECT payload FROM pos_impresiones WHERE empresa_id = $1 AND payload->>'area' = 'Barra' ORDER BY id DESC LIMIT 1", [A])).rows[0].payload;
        assert.equal(job.mesa, "Mesa 1");
        assert.equal(job.comanda, 1);
        assert.ok(job.mesero);
        assert.deepEqual(job.items, [{ cantidad: 3, nombre: "Latte", notas: null }]);
    });

    it("renglón enviado: no se edita; cancelarlo exige autorización y motivo", async () => {
        const c = (await req("GET", api("/cuentas/" + est.cuentaFlujo), { token: tokMesero })).json.data;
        const item = c.items.find((i) => i.nombre === "Pellegrino");
        assert.equal((await req("PUT", api(`/cuentas/${c.id}/items/${item.id}`), { token: tokMesero, body: { cantidad: 2 } })).status, 409);
        assert.equal((await req("DELETE", api(`/cuentas/${c.id}/items/${item.id}`), { token: tokMesero })).status, 409);
        assert.equal((await req("POST", api(`/cuentas/${c.id}/items/${item.id}/cancelar`), { token: tokMesero, body: { motivo: "x" } })).status, 403);
        assert.equal((await req("POST", api(`/cuentas/${c.id}/items/${item.id}/cancelar`), { token: tokSupervisor, body: {} })).status, 400);
        const ok = await req("POST", api(`/cuentas/${c.id}/items/${item.id}/cancelar`), { token: tokSupervisor, body: { motivo: "Cliente se arrepintió" } });
        assert.equal(ok.status, 200);
        const cancelado = ok.json.data.items.find((i) => i.id === item.id);
        assert.equal(cancelado.estado, "CANCELADO");
        assert.equal(cancelado.motivo, "Cliente se arrepintió");
        assert.equal(ok.json.data.totales.total, 3 * 55 + 120, "el cancelado ya no suma");
    });

    it("agente de impresión: token propio, toma trabajos una sola vez, confirma, reintenta y agota", async () => {
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes")).status, 401);
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes", { token: "gh_agt_falso" })).status, 401);

        const imp = (await req("POST", api("/impresoras"), { token: tokAdmin, body: { nombre: "Barra red", conexion: "RED", ip: "192.168.1.50", area_id: barra, ancho: 80 } }));
        assert.equal(imp.status, 201);
        assert.equal((await req("POST", api("/impresoras"), { token: tokAdmin, body: { nombre: "Mala", conexion: "RED", area_id: barra } })).status, 400, "red sin IP");
        assert.equal((await req("POST", api("/impresoras"), { token: tokAdmin, body: { nombre: "Sin uso", conexion: "USB", nombre_usb: "EPSON" } })).status, 400, "sin área ni ticket");
        assert.equal((await req("POST", api("/impresoras"), { token: tokMesero, body: { nombre: "X", conexion: "RED", ip: "1.1.1.1", area_id: barra } })).status, 403);

        const trabajo = (await pool.query("SELECT id FROM pos_impresiones WHERE empresa_id = $1 AND payload->>'area' = 'Barra' AND tipo = 'COMANDA' ORDER BY id DESC LIMIT 1", [A])).rows[0].id;
        assert.equal((await req("POST", api(`/impresiones/${trabajo}/reimprimir`), { token: tokMesero })).json.data.estado, "PENDIENTE");
        assert.equal((await req("POST", api(`/impresiones/${trabajo + 100000}/reimprimir`), { token: tokMesero })).status, 404);

        const ag = await req("POST", api("/agentes"), { token: tokAdmin, body: { nombre: "PC caja" } });
        assert.equal(ag.status, 201);
        const { token, agente } = ag.json.data;
        assert.match(token, /^gh_agt_[0-9a-f]{48}$/);
        const guardado = (await pool.query("SELECT token_hash FROM agentes_impresion WHERE id = $1", [agente.id])).rows[0].token_hash;
        assert.notEqual(guardado, token, "en la BD solo queda el hash");

        const pend = await req("GET", "/api/agente/impresiones/pendientes", { token, headers: { "x-agent-version": "1.0.0" } });
        assert.equal(pend.status, 200);
        assert.equal(pend.json.data.length, 1);
        assert.equal(pend.json.data[0].impresora.ip, "192.168.1.50");
        assert.equal(pend.json.data[0].payload.tipo, "COMANDA");
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes", { token })).json.data.length, 0, "no se entrega dos veces");

        const estado = (await req("GET", api("/impresion/estado"), { token: tokMesero })).json.data;
        assert.equal(estado.agentes_conectados, 1);

        const jid = pend.json.data[0].id;
        assert.equal(pend.json.data[0].reimpresiones, 0, "nunca se imprimió (estaba SIN_IMPRESORA): su primera salida no es una copia");
        assert.equal((await req("POST", `/api/agente/impresiones/${jid}/resultado`, { token, body: { ok: true } })).json.data.estado, "IMPRESO");
        assert.equal((await req("POST", `/api/agente/impresiones/${jid}/resultado`, { token, body: { ok: true } })).status, 404, "ya no está en impresión");

        // Cada reimpresion manual sube el contador: el agente la distingue de una re-entrega.
        await req("POST", api(`/impresiones/${jid}/reimprimir`), { token: tokMesero });
        const reimpreso = await req("GET", "/api/agente/impresiones/pendientes", { token });
        assert.equal(reimpreso.json.data[0].id, jid);
        assert.equal(reimpreso.json.data[0].reimpresiones, 1, "ya impreso: cada reimpresion manual sube el contador");
        await req("POST", `/api/agente/impresiones/${jid}/resultado`, { token, body: { ok: true } });

        // Fallo: vuelve a PENDIENTE con espera; al quinto intento queda en ERROR.
        await req("POST", api(`/impresiones/${jid}/reimprimir`), { token: tokMesero });
        for (let n = 1; n <= 5; n++) {
            await pool.query("UPDATE pos_impresiones SET bloqueado_hasta = NULL WHERE id = $1", [jid]);
            const t = await req("GET", "/api/agente/impresiones/pendientes", { token });
            assert.equal(t.json.data.length, 1, `intento ${n}`);
            const r = await req("POST", `/api/agente/impresiones/${jid}/resultado`, { token, body: { ok: false, error: "Impresora sin papel" } });
            assert.equal(r.json.data.estado, n < 5 ? "PENDIENTE" : "ERROR");
        }
        const final = (await pool.query("SELECT estado, intentos, error FROM pos_impresiones WHERE id = $1", [jid])).rows[0];
        assert.deepEqual([final.estado, final.intentos, final.error], ["ERROR", 5, "Impresora sin papel"]);

        const rot = await req("POST", api(`/agentes/${agente.id}/rotar-token`), { token: tokAdmin });
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes", { token })).status, 401, "el token anterior deja de servir");
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes", { token: rot.json.data.token })).status, 200);
        await req("PUT", api(`/agentes/${agente.id}`), { token: tokAdmin, body: { activo: false } });
        assert.equal((await req("GET", "/api/agente/impresiones/pendientes", { token: rot.json.data.token })).status, 401);
    });

    it("el agente de una empresa no recibe trabajos de otra", async () => {
        const otro = (await req("POST", `/api/pos/${B}/agentes`, { token: tokAdminB, body: { nombre: "Otra PC" } })).json.data.token;
        const r = await req("GET", "/api/agente/impresiones/pendientes", { token: otro });
        assert.deepEqual(r.json.data, []);
    });

    it("cambiar de mesa: a una libre sí; a una ocupada 409; las cuentas para llevar no cambian de mesa", async () => {
        const c = est.cuentaFlujo;
        const ocupada = await abrir(m2);
        assert.equal((await req("POST", api(`/cuentas/${c}/cambiar-mesa`), { token: tokMesero, body: { mesa_id: m2 } })).status, 409);
        const sol = await req("POST", api(`/cuentas/${c}/cambiar-mesa`), { token: tokMesero, body: { mesa_id: m3 } });
        assert.equal(sol.json.data.mesa, "Mesa 3");
        assert.equal((await req("POST", api(`/cuentas/${c}/cambiar-mesa`), { token: tokMesero, body: { mesa_id: m3 } })).status, 400);
        const llevar = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "LLEVAR", nombre_cliente: "Luis" } })).json.data;
        assert.equal(llevar.mesa_id, null);
        assert.equal((await req("POST", api(`/cuentas/${llevar.id}/cambiar-mesa`), { token: tokMesero, body: { mesa_id: m1 } })).status, 400);
        est.cuentaMesa2 = ocupada.id;
        est.cuentaLlevar = llevar.id;
        await req("POST", api(`/cuentas/${c}/cambiar-mesa`), { token: tokMesero, body: { mesa_id: m1 } });
    });

    it("dividir: mueve renglones completos o parte de la cantidad a una cuenta nueva de la misma mesa", async () => {
        const c = est.cuentaMesa2;
        const base = await agregar(c, [linea(latte, 4), linea(baguette, 2)]);
        const itemLatte = base.items.find((i) => i.nombre === "Latte");
        const itemBag = base.items.find((i) => i.nombre === "Baguette");

        assert.equal((await req("POST", api(`/cuentas/${c}/dividir`), { token: tokMesero, body: { partes: [{ item_id: itemLatte.id, cantidad: 5 }] } })).status, 400, "más de lo que hay");
        assert.equal((await req("POST", api(`/cuentas/${c}/dividir`), { token: tokMesero, body: { partes: [{ item_id: itemLatte.id, cantidad: 4 }, { item_id: itemBag.id, cantidad: 2 }] } })).status, 400, "no puede quedar vacía");

        const r = await req("POST", api(`/cuentas/${c}/dividir`), { token: tokMesero, body: { partes: [{ item_id: itemLatte.id, cantidad: 1 }, { item_id: itemBag.id, cantidad: 2 }] } });
        assert.equal(r.status, 200);
        const { origen, nueva } = r.json.data;
        assert.equal(origen.items.length, 1);
        assert.equal(origen.items[0].cantidad, 3);
        assert.equal(nueva.mesa_id, origen.mesa_id);
        assert.equal(nueva.dividida_de, origen.id);
        assert.deepEqual(nueva.items.map((i) => [i.nombre, i.cantidad]).sort(), [["Baguette", 2], ["Latte", 1]]);
        assert.equal(origen.totales.total + nueva.totales.total, 4 * PRECIO_LATTE + 2 * 120, "dividir no cambia el total");
        est.cuentaDividida = nueva.id;
    });

    it("mapa de mesas: cuentas abiertas por mesa con su total, y las de llevar aparte", async () => {
        const mapa = (await req("GET", api("/mapa"), { token: tokHostess })).json.data;
        const mesa2 = mapa.mesas.find((m) => m.id === m2);
        assert.equal(mesa2.cuentas.length, 2, "la mesa dividida muestra sus dos cuentas");
        assert.equal(mesa2.cuentas.reduce((s, c) => s + c.total, 0), 4 * PRECIO_LATTE + 2 * 120);
        assert.ok(mesa2.cuentas.every((c) => c.por_enviar > 0));
        assert.ok(mesa2.cuentas.every((c) => Number.isInteger(c.mesero_id)), "el mapa trae el id del mesero (filtro Mías)");
        assert.equal(mapa.llevar.length, 1);
        assert.equal(mapa.llevar[0].nombre_cliente, "Luis");
        assert.equal(mapa.mesas.find((m) => m.id === m3).cuentas.length, 0, "Mesa 3 quedó libre al mover la cuenta");
    });

    it("juntar cuentas: pasa renglones y personas a la destino y la origen queda UNIDA", async () => {
        const [origen, destino] = [est.cuentaDividida, est.cuentaMesa2];
        assert.equal((await req("POST", api(`/cuentas/${origen}/juntar`), { token: tokMesero, body: { destino_id: origen } })).status, 400);
        const r = await req("POST", api(`/cuentas/${origen}/juntar`), { token: tokMesero, body: { destino_id: destino } });
        assert.equal(r.status, 200);
        assert.equal(r.json.data.items.length, 3);
        assert.equal(r.json.data.personas, 3);
        assert.equal(r.json.data.totales.total, 4 * PRECIO_LATTE + 2 * 120);
        const vieja = (await req("GET", api(`/cuentas/${origen}`), { token: tokMesero })).json.data;
        assert.equal(vieja.estado, "UNIDA");
        assert.equal(vieja.unida_a, destino);
        assert.equal((await req("POST", api(`/cuentas/${origen}/juntar`), { token: tokMesero, body: { destino_id: destino } })).status, 409, "una unida no se junta otra vez");
    });

    it("precuenta: se encola para tickets con los totales; sin productos 400; sin impresora de tickets queda en SIN_IMPRESORA", async () => {
        const vacia = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "LLEVAR" } })).json.data;
        assert.equal((await req("POST", api(`/cuentas/${vacia.id}/precuenta`), { token: tokMesero })).status, 400);

        const sin = await req("POST", api(`/cuentas/${est.cuentaMesa2}/precuenta`), { token: tokMesero });
        assert.equal(sin.status, 200);
        assert.equal(sin.json.data.impresion_estado, "SIN_IMPRESORA");
        assert.equal(sin.json.data.payload.totales.total, 4 * PRECIO_LATTE + 2 * 120);

        await req("POST", api("/impresoras"), { token: tokAdmin, body: { nombre: "Caja", conexion: "USB", nombre_usb: "EPSON TM-T20", es_ticket: true, ancho: 58 } });
        const con = await req("POST", api(`/cuentas/${est.cuentaMesa2}/precuenta`), { token: tokMesero });
        assert.equal(con.json.data.impresion_estado, "PENDIENTE");
        assert.equal(con.json.data.payload.items.length, 3);
        await req("POST", api(`/cuentas/${vacia.id}/cancelar`), { token: tokMesero, body: {} });
    });

    it("cancelar cuenta: sin enviados cualquiera; con enviados solo con autorización y motivo", async () => {
        const nueva = await abrir(m3);
        await agregar(nueva.id, [linea(latte)]);
        const sinEnviar = await req("POST", api(`/cuentas/${nueva.id}/cancelar`), { token: tokMesero, body: {} });
        assert.equal(sinEnviar.json.data.estado, "CANCELADA");
        assert.equal(sinEnviar.json.data.items.length, 0, "los pendientes se descartan");
        assert.equal((await req("POST", api(`/cuentas/${nueva.id}/cancelar`), { token: tokMesero, body: {} })).status, 409);

        const conEnviados = est.cuentaMesa2;
        assert.equal((await req("POST", api(`/cuentas/${conEnviados}/enviar`), { token: tokMesero })).status, 200);
        assert.equal((await req("POST", api(`/cuentas/${conEnviados}/cancelar`), { token: tokMesero, body: { motivo: "x" } })).status, 403);
        assert.equal((await req("POST", api(`/cuentas/${conEnviados}/cancelar`), { token: tokSupervisor, body: {} })).status, 400);
        const ok = await req("POST", api(`/cuentas/${conEnviados}/cancelar`), { token: tokSupervisor, body: { motivo: "Mesa se fue" } });
        assert.equal(ok.json.data.estado, "CANCELADA");
        assert.equal(ok.json.data.items.length, 3, "lo enviado se conserva para auditoría");
    });

    it("caja: el cajero abre con fondo; no dos abiertas; el mesero no abre caja; el turno actual es suyo", async () => {
        assert.equal((await req("GET", api("/turnos/actual"), { token: tokCajero })).json.data, null);
        assert.equal((await req("POST", api("/turnos/abrir"), { token: tokMesero, body: { fondo_inicial: 500 } })).status, 403);
        assert.equal((await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 10.123 } })).status, 400, "máximo 2 decimales");
        const t = await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 500 } });
        assert.equal(t.status, 201);
        assert.equal(Number(t.json.data.fondo_inicial), 500);
        assert.equal((await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 0 } })).status, 409);
        assert.equal((await req("GET", api("/turnos/actual"), { token: tokCajero })).json.data.id, t.json.data.id);
        assert.equal((await req("GET", api("/turnos/actual"), { token: tokSupervisor })).json.data, null);
    });

    it("tocar el mismo producto varias veces suma en un renglón; con notas o ya enviado, renglón aparte", async () => {
        const c = await abrir(m3);
        await agregar(c.id, [linea(latte)]);
        const dos = await agregar(c.id, [linea(latte), linea(latte, 2)]);
        assert.equal(dos.items.length, 1);
        assert.equal(dos.items[0].cantidad, 4);
        const conNota = await agregar(c.id, [linea(latte, 1, "sin hielo")]);
        assert.equal(conNota.items.length, 2, "con notas no se mezcla");
        // El tope de 99 por renglón avisa en lugar de recortar en silencio, y no cambia lo ya capturado.
        const pasado = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: { lineas: [linea(latte, 99)] } });
        assert.equal(pasado.status, 400);
        assert.match(pasado.json.error, /máximo 99/);
        assert.equal((await req("GET", api(`/cuentas/${c.id}`), { token: tokMesero })).json.data.items.find((i) => !i.notas).cantidad, 4);
        const tope = await agregar(c.id, [linea(latte, 95)]);
        assert.equal(tope.items.find((i) => !i.notas).cantidad, 99, "se puede llegar exactamente a 99");
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        const nuevo = await agregar(c.id, [linea(latte)]);
        assert.equal(nuevo.items.filter((i) => i.estado === "PENDIENTE").length, 1, "tras enviar, lo nuevo es otro renglón");
        assert.equal(nuevo.items.length, 3);
        await req("POST", api(`/cuentas/${c.id}/cancelar`), { token: tokSupervisor, body: { motivo: "prueba" } });
    });

    it("nombrar la cuenta y última actividad: se renombra y cambia personas; el mapa avisa cuándo fue lo último que se tocó", async () => {
        const c = (await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "LLEVAR", personas: 1, nombre_cliente: "Luis M." } })).json.data;
        const mapa = async () => (await req("GET", api("/mapa"), { token: tokMesero })).json.data.llevar.find((x) => x.id === c.id);
        const inicio = await mapa();
        assert.ok(inicio.actualizada_at, "el mapa trae la última actividad");

        await new Promise((r) => setTimeout(r, 30));
        const r = await req("PATCH", api(`/cuentas/${c.id}`), { token: tokMesero, body: { nombre_cliente: "Sr. Herrera", personas: 4 } });
        assert.equal(r.status, 200);
        assert.equal(r.json.data.nombre_cliente, "Sr. Herrera");
        assert.equal(r.json.data.personas, 4);
        const trasNombre = await mapa();
        assert.ok(new Date(trasNombre.actualizada_at) > new Date(inicio.actualizada_at), "renombrar cuenta como actividad");
        assert.equal(trasNombre.abierta_at, inicio.abierta_at, "la hora de apertura no cambia");

        await new Promise((r2) => setTimeout(r2, 30));
        await agregar(c.id, [linea(latte)]);
        const trasItem = await mapa();
        assert.ok(new Date(trasItem.actualizada_at) > new Date(trasNombre.actualizada_at), "agregar un producto también cuenta");

        // Vaciar el nombre lo quita; sin campos, 400; una cuenta ya cerrada no se edita; el hostess (solo lectura) no puede.
        assert.equal((await req("PATCH", api(`/cuentas/${c.id}`), { token: tokMesero, body: { nombre_cliente: "" } })).json.data.nombre_cliente, null);
        assert.equal((await req("PATCH", api(`/cuentas/${c.id}`), { token: tokMesero, body: {} })).status, 400);
        assert.equal((await req("PATCH", api(`/cuentas/${c.id}`), { token: tokHostess, body: { personas: 2 } })).status, 403);
        await req("POST", api(`/cuentas/${c.id}/cancelar`), { token: tokMesero, body: { motivo: "Prueba" } });
        assert.equal((await req("PATCH", api(`/cuentas/${c.id}`), { token: tokMesero, body: { nombre_cliente: "x" } })).status, 409);
    });

    it("salir sin enviar: se descarta lo pendiente y, si la cuenta queda vacía, se borra y la mesa queda libre", async () => {
        const mesa = (await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre: "Mesa descarte", capacidad: 2 } })).json.data.id;
        const libre = async () => (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas.find((m) => m.id === mesa).cuentas.length === 0;

        // 1) Abrir y salir sin tocar nada: la mesa queda libre y el folio se reutiliza.
        const a = await abrir(mesa);
        assert.equal(await libre(), false);
        const d1 = await req("POST", api(`/cuentas/${a.id}/descartar`), { token: tokMesero });
        assert.equal(d1.status, 200);
        assert.equal(d1.json.data.eliminada, true);
        assert.equal(await libre(), true);
        assert.equal((await req("GET", api(`/cuentas/${a.id}`), { token: tokMesero })).status, 404);
        const b = await abrir(mesa);
        assert.equal(b.folio, a.folio, "el folio de una cuenta que nunca existió se devuelve");

        // 2) Con productos sin enviar: también se borra todo.
        await agregar(b.id, [linea(latte, 2), linea(baguette)]);
        const d2 = await req("POST", api(`/cuentas/${b.id}/descartar`), { token: tokMesero });
        assert.equal(d2.json.data.eliminada, true);
        assert.equal(await libre(), true);

        // 3) Con algo ya enviado: solo se descarta lo pendiente y la cuenta sigue abierta.
        const c = await abrir(mesa);
        await agregar(c.id, [linea(latte)]);
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        await agregar(c.id, [linea(baguette, 3)]);
        const d3 = await req("POST", api(`/cuentas/${c.id}/descartar`), { token: tokMesero });
        assert.equal(d3.json.data.eliminada, false);
        assert.deepEqual(d3.json.data.cuenta.items.map((i) => [i.nombre, i.estado]), [["Latte", "ENVIADO"]]);
        assert.equal(d3.json.data.cuenta.estado, "ABIERTA");
        assert.equal(await libre(), false);

        // Solo cuentas abiertas; el hostess (solo lectura) no puede.
        assert.equal((await req("POST", api(`/cuentas/${c.id}/descartar`), { token: tokHostess })).status, 403);
        await req("POST", api(`/cuentas/${c.id}/cancelar`), { token: tokAdmin, body: { motivo: "Prueba" } });
        assert.equal((await req("POST", api(`/cuentas/${c.id}/descartar`), { token: tokMesero })).status, 409);
    });

    it("una cuenta vacía abandonada más de 30 minutos se libera sola al consultar el mapa; con productos no", async () => {
        const mesa = (await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre: "Mesa abandono", capacidad: 2 } })).json.data.id;
        const vacia = await abrir(mesa);
        const otra = (await req("POST", api("/mesas"), { token: tokAdmin, body: { nombre: "Mesa con producto", capacidad: 2 } })).json.data.id;
        const conProducto = await abrir(otra);
        await agregar(conProducto.id, [linea(latte)]);
        // El trigger de actividad pisa la fecha: se apaga un momento para simular que pasó el tiempo.
        await pool.query("ALTER TABLE pos_cuentas DISABLE TRIGGER pos_cuentas_actividad");
        try {
            await pool.query("UPDATE pos_cuentas SET actualizada_at = now() - interval '45 minutes' WHERE id = ANY($1)", [[vacia.id, conProducto.id]]);
        } finally {
            await pool.query("ALTER TABLE pos_cuentas ENABLE TRIGGER pos_cuentas_actividad");
        }
        reiniciarPurga(); // la revisión se hace a lo mucho una vez por minuto por empresa
        const mapa = (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas;
        assert.equal(mapa.find((m) => m.id === mesa).cuentas.length, 0, "la vacía se liberó");
        assert.equal(mapa.find((m) => m.id === otra).cuentas.length, 1, "la que tiene productos se queda");
        assert.equal((await req("GET", api(`/cuentas/${vacia.id}`), { token: tokMesero })).status, 404);
    });

    it("aislamiento: una cuenta de otra empresa no se ve ni se toca, aunque se conozca su id", async () => {
        const c = est.cuentaFlujo;
        assert.equal((await req("GET", `/api/pos/${B}/cuentas/${c}`, { token: tokAdminB })).status, 404);
        assert.equal((await req("POST", `/api/pos/${B}/cuentas/${c}/enviar`, { token: tokAdminB })).status, 404);
        assert.equal((await req("GET", api(`/cuentas/${c}`), { token: tokAdminB })).status, 403);
    });
});
