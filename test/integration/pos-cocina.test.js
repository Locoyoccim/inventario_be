import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Pantalla de cocina (KDS) opcional: estado de las comandas, seguimiento del mesero y cancelaciones.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — pantalla de cocina (KDS) opcional", { skip: SKIP }, () => {
    const A = 9731;
    const B = 9732;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokCocina, tokSupervisor, tokCocinaB;
    let mesas = [];
    let latte, baguette, cocinaId, barraId;

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
    const linea = (a, cantidad = 1) => ({ tipo: "RECETA", id: a, cantidad });
    const agregar = (c, lineas) => req("POST", api(`/cuentas/${c}/items`), { token: tokMesero, body: { lineas } });
    const enviar = (c) => req("POST", api(`/cuentas/${c}/enviar`), { token: tokMesero });
    const cuenta = async (c, token = tokMesero) => (await req("GET", api(`/cuentas/${c}`), { token })).json.data;
    const estado = (id, e, token = tokCocina) => req("POST", api(`/comandas/${id}/estado`), { token, body: { estado: e } });
    const activas = async (area, token = tokCocina) => (await req("GET", api(`/comandas/activas${area ? `?area_id=${area}` : ""}`), { token }));
    const pantalla = (activa) => req("PUT", `/api/empresas/${A}/configuracion`, { body: { usa_pantalla_cocina: activa } });
    const estadoDb = async (id) => (await pool.query("SELECT estado FROM pos_comandas WHERE id = $1", [id])).rows[0].estado;
    // Cuenta con un latte (Barra) y una baguette (Cocina), ya enviada.
    const enviada = async () => {
        const c = await abrir();
        await agregar(c.id, [linea(latte), linea(baguette)]);
        const r = await enviar(c.id);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        return { c, comandas: r.json.data.comandas };
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Cocina'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n", [[A, B], ["Bebidas", "Platillos", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "KD-adm", { admin: true });
        tokMesero = await mkUsuario(A, "KD-mes", { rol: "mesero" });
        tokCocina = await mkUsuario(A, "KD-coc", { rol: "cocina" });
        tokSupervisor = await mkUsuario(A, "KD-sup", { rol: "supervisor" });
        tokCocinaB = await mkUsuario(B, "KD-cocB", { rol: "cocina" });
        for (let i = 1; i <= 30; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);
        const areas = (await req("GET", api("/areas"))).json.data;
        cocinaId = areas.find((a) => a.nombre === "Cocina").id;
        barraId = areas.find((a) => a.nombre === "Barra").id;
        const prov = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const insumo = (await req("POST", `/api/productos/${A}`, { body: { producto: "Insumo", categoria: "Insumo", unidad_medida: "pz", proveedor_id: prov, cantidad_presentacion: 1, costo_presentacion: 5, stock_minimo: 0, stock_actual: 500 } })).json.data.id;
        const receta = async (nombre, categoria, precio, area) => {
            const id = (await req("POST", `/api/recetas/${A}`, { body: { nombre, categoria, precio_venta: precio, ingredientes: [{ producto_id: insumo, cantidad: 1 }] } })).json.data.id;
            await req("PUT", api(`/asignacion-areas/receta/${id}`), { body: { area_id: area } });
            return id;
        };
        latte = await receta("Latte", "Bebidas", 58, barraId);
        baguette = await receta("Baguette", "Platillos", 120, cocinaId);
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    it("la pantalla es opcional y viene apagada: enviar se comporta como siempre (solo papel) y nada aparece en pantalla", async () => {
        const { c, comandas } = await enviada();
        assert.equal(comandas.length, 2);
        for (const k of comandas) {
            assert.ok(k.impresion_id, "cada comanda genera su trabajo de impresión");
            assert.equal(k.pantalla, false);
            assert.equal(await estadoDb(k.id), "ENTREGADA", "sin pantalla nadie la va a marcar");
        }
        assert.equal((await activas(null, tokAdmin)).json.data.length, 0);
        const intento = await req("PUT", api(`/areas/${barraId}`), { body: { pantalla: true } });
        assert.equal(intento.status, 409, "una área no puede usar pantalla si la empresa no la activó");
        assert.equal((await cuenta(c.id)).comandas.every((k) => k.pantalla === false), true);
        assert.equal((await req("GET", api("/impresion/estado"), { token: tokMesero })).json.data.pantalla_cocina, false);
    });

    it("al activarla, cada área elige papel, pantalla o ambos; un área solo de pantalla no genera trabajo de impresión", async () => {
        assert.equal((await pantalla(true)).status, 200);
        assert.equal((await req("GET", api("/impresion/estado"), { token: tokMesero })).json.data.pantalla_cocina, true);
        // Barra: solo pantalla. Cocina: papel y pantalla.
        const b = await req("PUT", api(`/areas/${barraId}`), { body: { pantalla: true, imprime: false, tiempo_objetivo_min: 6 } });
        assert.equal(b.status, 200, JSON.stringify(b.json));
        assert.equal(b.json.data.tiempo_objetivo_min, 6);
        assert.equal((await req("PUT", api(`/areas/${cocinaId}`), { body: { pantalla: true } })).status, 200);

        const { c, comandas } = await enviada();
        const barra = comandas.find((k) => k.area === "Barra");
        const cocina = comandas.find((k) => k.area === "Cocina");
        assert.equal(barra.impresion_id, null, "solo pantalla: sin impresión");
        assert.equal(barra.impresion_estado, null);
        assert.equal(barra.pantalla, true);
        assert.ok(cocina.impresion_id, "papel y pantalla: sí imprime");
        assert.equal(await estadoDb(barra.id), "NUEVA");
        assert.equal(await estadoDb(cocina.id), "NUEVA");
        const sinTrabajo = (await pool.query("SELECT count(*)::int AS n FROM pos_impresiones WHERE tipo = 'COMANDA' AND referencia_id = $1", [barra.id])).rows[0].n;
        assert.equal(sinTrabajo, 0);
        const seguimiento = (await cuenta(c.id)).comandas.map((k) => [k.area, k.estado, k.pantalla]).sort((x, y) => x[0].localeCompare(y[0]));
        assert.deepEqual(seguimiento, [["Barra", "NUEVA", true], ["Cocina", "NUEVA", true]]);
    });

    it("la pantalla muestra lo activo por área con sus renglones y solo la ve quien tiene el permiso de cocina", async () => {
        const { comandas } = await enviada();
        const barra = comandas.find((k) => k.area === "Barra");
        const todas = (await activas()).json.data;
        assert.ok(todas.some((k) => k.id === barra.id));
        const soloBarra = (await activas(barraId)).json.data;
        assert.ok(soloBarra.length > 0 && soloBarra.every((k) => k.area === "Barra"));
        const k = soloBarra.find((x) => x.id === barra.id);
        assert.equal(k.tiempo_objetivo_min, 6);
        assert.equal(k.renglones.length, 1);
        assert.equal(k.renglones[0].nombre, "Latte");
        assert.ok(k.mesa && k.mesero && k.folio);
        assert.equal((await activas(null, tokMesero)).status, 403, "el mesero no ve la pantalla de cocina");
        assert.equal((await activas(null, tokSupervisor)).status, 200);
    });

    it("estados: cocina prepara y deja lista; el mesero la marca entregada; no hay saltos ni retrocesos", async () => {
        const { c, comandas } = await enviada();
        const id = comandas.find((k) => k.area === "Barra").id;
        assert.equal((await estado(id, "LISTA", tokMesero)).status, 403, "el mesero no marca preparación");
        assert.equal((await estado(id, "ENTREGADA", tokMesero)).status, 409, "aún no está lista");
        assert.equal((await estado(id, "EN_PREPARACION")).status, 200);
        assert.equal(await estadoDb(id), "EN_PREPARACION");
        const lista = await estado(id, "LISTA");
        assert.equal(lista.status, 200);
        assert.equal((await estado(id, "LISTA")).status, 200, "repetir el mismo estado no es un error (otra tablet ya lo hizo)");
        // El mapa avisa al mesero que tiene una comanda lista; en la cuenta aparece con su hora.
        const mapa = (await req("GET", api("/mapa"), { token: tokMesero })).json.data;
        const resumen = mapa.mesas.flatMap((m) => m.cuentas).find((x) => x.id === c.id);
        assert.equal(resumen.comandas_listas, 1);
        assert.ok((await cuenta(c.id)).comandas.find((k) => k.id === id).lista_at);
        assert.equal((await estado(id, "ENTREGADA", tokMesero)).status, 200);
        const despues = (await req("GET", api("/mapa"), { token: tokMesero })).json.data.mesas.flatMap((m) => m.cuentas).find((x) => x.id === c.id);
        assert.equal(despues.comandas_listas, 0);
        assert.equal((await estado(id, "EN_PREPARACION")).status, 409, "una comanda entregada no regresa");
        assert.equal((await estado(id, "LISTA")).status, 409);
        assert.equal((await estado(999999, "LISTA")).status, 404);
    });

    it("deshacer «lista» solo es posible durante unos minutos", async () => {
        const { comandas } = await enviada();
        const id = comandas.find((k) => k.area === "Barra").id;
        await estado(id, "LISTA");
        assert.equal((await estado(id, "EN_PREPARACION")).status, 200, "se regresó a preparación");
        await estado(id, "LISTA");
        await pool.query("UPDATE pos_comandas SET lista_at = now() - interval '11 minutes' WHERE id = $1", [id]);
        const tarde = await estado(id, "EN_PREPARACION");
        assert.equal(tarde.status, 409);
        assert.match(tarde.json.error, /minutos/);
        assert.equal(await estadoDb(id), "LISTA");
    });

    it("dos tablets marcando lo mismo a la vez no chocan", async () => {
        const { comandas } = await enviada();
        const id = comandas.find((k) => k.area === "Cocina").id;
        const r = await Promise.all([estado(id, "LISTA"), estado(id, "LISTA"), estado(id, "LISTA")]);
        assert.deepEqual(r.map((x) => x.status), [200, 200, 200]);
        assert.equal(await estadoDb(id), "LISTA");
        const filas = (await pool.query("SELECT lista_at FROM pos_comandas WHERE id = $1", [id])).rows;
        assert.ok(filas[0].lista_at);
    });

    it("las listas siguen en pantalla un rato y luego salen; las entregadas no aparecen", async () => {
        const { comandas } = await enviada();
        const id = comandas.find((k) => k.area === "Barra").id;
        await estado(id, "LISTA");
        assert.ok((await activas(barraId)).json.data.some((k) => k.id === id));
        await pool.query("UPDATE pos_comandas SET lista_at = now() - interval '11 minutes' WHERE id = $1", [id]);
        assert.equal((await activas(barraId)).json.data.some((k) => k.id === id), false);
    });

    it("cancelar un renglón enviado: la cocina lo ve tachado y, si no queda nada, la comanda se cancela", async () => {
        const c = await abrir();
        await agregar(c.id, [linea(latte, 1), linea(latte, 1)].map((l, i) => ({ ...l, ...(i ? { notas: "sin hielo" } : {}) })));
        const env = await enviar(c.id);
        const barra = env.json.data.comandas.find((k) => k.area === "Barra");
        const items = (await cuenta(c.id)).items;
        assert.equal(items.length, 2);
        const cancelar = (item) => req("POST", api(`/cuentas/${c.id}/items/${item}/cancelar`), { token: tokSupervisor, body: { motivo: "se arrepintió" } });
        assert.equal((await cancelar(items[0].id)).status, 200);
        let k = (await activas(barraId)).json.data.find((x) => x.id === barra.id);
        assert.equal(k.estado, "NUEVA", "aún queda un renglón por preparar");
        assert.equal(k.renglones.filter((r) => r.cancelado).length, 1);
        assert.equal((await cancelar(items[1].id)).status, 200);
        assert.equal(await estadoDb(barra.id), "CANCELADA");
        k = (await activas(barraId)).json.data.find((x) => x.id === barra.id);
        assert.equal(k.estado, "CANCELADA", "se muestra un momento para que la cocina vea que ya no se prepara");
        assert.equal((await estado(barra.id, "LISTA")).status, 409, "una comanda cancelada no se puede preparar");
    });

    it("cancelar toda la cuenta cancela lo que siga por preparar", async () => {
        const { c, comandas } = await enviada();
        const [x, y] = comandas;
        await estado(y.id, "LISTA");
        const r = await req("POST", api(`/cuentas/${c.id}/cancelar`), { token: tokSupervisor, body: { motivo: "se fueron" } });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(await estadoDb(x.id), "CANCELADA");
        assert.equal(await estadoDb(y.id), "CANCELADA");
    });

    it("al dividir la cuenta, la nueva ve sus comandas por los renglones que se llevó", async () => {
        const c = await abrir();
        await agregar(c.id, [linea(latte), linea(baguette)]);
        await enviar(c.id);
        const items = (await cuenta(c.id)).items;
        const baguetteItem = items.find((i) => i.nombre === "Baguette");
        const dividido = await req("POST", api(`/cuentas/${c.id}/dividir`), { token: tokMesero, body: { partes: [{ item_id: baguetteItem.id, cantidad: 1 }] } });
        assert.equal(dividido.status, 200, JSON.stringify(dividido.json));
        const nueva = dividido.json.data.nueva;
        assert.deepEqual(nueva.comandas.map((k) => k.area), ["Cocina"], "la nueva cuenta ve la comanda de lo que se llevó");
        assert.deepEqual(dividido.json.data.origen.comandas.map((k) => k.area), ["Barra"]);
    });

    it("un área sin impresora ni pantalla sigue sin comanda; y las pruebas de otra empresa no ven ni tocan estas comandas", async () => {
        const { comandas } = await enviada();
        const id = comandas[0].id;
        assert.equal((await estado(id, "LISTA", tokCocinaB)).status, 403, "otra empresa no entra a las rutas de esta");
        // Aunque use las suyas con un id ajeno: no existe en su empresa.
        const ajeno = await req("POST", api(`/comandas/${id}/estado`, B), { token: tokCocinaB, body: { estado: "LISTA" } });
        assert.equal(ajeno.status, 404);
        assert.equal((await activas(null, tokCocinaB)).status, 403);
        const sinComanda = (await req("GET", api("/areas"))).json.data.find((a) => a.nombre === "Sin comanda");
        assert.equal(sinComanda.pantalla, false);
    });

    it("apagar la pantalla no borra nada: lo que seguía abierto se da por entregado y todo vuelve a solo papel", async () => {
        const { comandas } = await enviada();
        assert.ok((await activas()).json.data.length > 0);
        assert.equal((await pantalla(false)).status, 200);
        for (const k of comandas) assert.equal(await estadoDb(k.id), "ENTREGADA");
        assert.equal((await activas(null, tokAdmin)).json.data.length, 0);
        // Las áreas conservan su configuración, pero ya no generan comandas de pantalla.
        const { comandas: nuevas } = await enviada();
        assert.equal(nuevas.every((k) => k.pantalla === false), true);
        assert.ok(nuevas.find((k) => k.area === "Barra").impresion_id, "Barra era solo pantalla: al apagarla vuelve a imprimir en lugar de quedarse sin comanda");
        const barra = (await req("GET", api("/areas"))).json.data.find((a) => a.nombre === "Barra");
        assert.deepEqual([barra.imprime, barra.pantalla], [true, true], "conserva la opción de pantalla por si se reactiva");
    });
});
