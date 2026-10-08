import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Llaves de idempotencia del POS: un reintento con la misma llave devuelve lo ya hecho y no repite el efecto.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — idempotencia del POS", { skip: SKIP }, () => {
    const A = 9721;
    const B = 9722;
    let server, base, pool, signToken;
    let tokAdmin, tokMesero, tokMesero2, tokCajero, tokAdminB;
    let mesas = [];
    let latte;
    let llave = 0;
    const nueva = () => `test-${Date.now()}-${++llave}-abcdef`;

    const req = async (method, path, { token = tokAdmin, body, key } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* vacío */ }
        return { status: res.status, json, replay: res.headers.get("idempotent-replay") === "true" };
    };
    const api = (p, e = A) => `/api/pos/${e}${p}`;

    const limpiar = async () => {
        const e = [[A, B]];
        for (const t of ["pos_idempotencia", "ingresos", "pos_impresiones", "impresoras", "pos_autorizaciones", "pos_pagos", "pos_cuenta_items", "pos_comandas", "pos_cuentas", "pos_turnos", "pos_folios"]) {
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
    const items = async (id) => (await req("GET", api(`/cuentas/${id}`), { token: tokMesero })).json.data.items;
    const stock = async (producto) => Number((await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [producto])).rows[0].stock_actual);

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Idem'), ($2,'Otra')", [A, B]);
        await pool.query("INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n", [A, ["Bebidas", "Insumo"]]);
        tokAdmin = await mkUsuario(A, "ID-adm", { admin: true });
        tokMesero = await mkUsuario(A, "ID-mes", { rol: "mesero" });
        tokMesero2 = await mkUsuario(A, "ID-mes2", { rol: "mesero" });
        tokCajero = await mkUsuario(A, "ID-caj", { rol: "cajero" });
        tokAdminB = await mkUsuario(B, "ID-admB", { admin: true });
        for (let i = 1; i <= 24; i++) mesas.push((await req("POST", api("/mesas"), { body: { nombre: `Mesa ${i}`, capacidad: 4 } })).json.data.id);
        const prov = (await req("POST", `/api/proveedores/${A}`, { body: { nombre: "Prov" } })).json.data.id;
        const leche = (await req("POST", `/api/productos/${A}`, { body: { producto: "Leche", categoria: "Insumo", unidad_medida: "pz", proveedor_id: prov, cantidad_presentacion: 1, costo_presentacion: 10, stock_minimo: 0, stock_actual: 100 } })).json.data.id;
        latte = (await req("POST", `/api/recetas/${A}`, { body: { nombre: "Latte", categoria: "Bebidas", precio_venta: 58, ingredientes: [{ producto_id: leche, cantidad: 1 }] } })).json.data.id;
        const barra = (await req("GET", api("/areas"))).json.data.find((a) => a.nombre === "Barra").id;
        await req("PUT", api(`/asignacion-areas/receta/${latte}`), { body: { area_id: barra } });
        await req("POST", api("/turnos/abrir"), { token: tokCajero, body: { fondo_inicial: 0 } });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        server.close();
    });

    const linea = (cantidad = 1) => ({ lineas: [{ tipo: "RECETA", id: latte, cantidad }] });

    it("agregar con la misma llave dos veces suma una sola vez y la segunda devuelve la misma respuesta", async () => {
        const c = await abrir();
        const k = nueva();
        const a = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(2), key: k });
        const b = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(2), key: k });
        assert.equal(a.status, 201);
        assert.equal(b.status, 201);
        assert.equal(a.replay, false);
        assert.equal(b.replay, true, "la segunda es una repetición");
        assert.deepEqual(b.json, a.json);
        assert.equal((await items(c.id))[0].cantidad, 2, "solo se agregó una vez");
        // Otra llave sí es otra acción.
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1), key: nueva() });
        assert.equal((await items(c.id))[0].cantidad, 3);
    });

    it("sin llave todo sigue igual: dos agregados suman y un segundo enviar da 400", async () => {
        const c = await abrir();
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1) });
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1) });
        assert.equal((await items(c.id))[0].cantidad, 2);
        assert.equal((await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero })).status, 200);
        assert.equal((await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero })).status, 400);
    });

    it("enviar con la misma llave: el reintento recibe las mismas comandas en lugar del 400 «No hay productos por enviar»", async () => {
        const c = await abrir();
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1) });
        const k = nueva();
        const a = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, key: k });
        const b = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, key: k });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.equal(b.status, 200);
        assert.equal(b.replay, true);
        assert.deepEqual(b.json.data.comandas, a.json.data.comandas);
        const comandas = (await pool.query("SELECT count(*)::int AS n FROM pos_comandas WHERE cuenta_id = $1", [c.id])).rows[0].n;
        assert.equal(comandas, 1, "una sola comanda");
        const trabajos = (await pool.query("SELECT count(*)::int AS n FROM pos_impresiones WHERE empresa_id = $1 AND tipo = 'COMANDA' AND referencia_id = $2", [A, a.json.data.comandas[0].id])).rows[0].n;
        assert.equal(trabajos, 1, "un solo trabajo de impresión");
    });

    it("dos peticiones iguales a la vez producen un solo efecto y ambas responden lo mismo", async () => {
        const c = await abrir();
        const k = nueva();
        const [a, b] = await Promise.all([
            req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(3), key: k }),
            req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(3), key: k }),
        ]);
        assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify([a.json, b.json]));
        assert.equal([a, b].filter((r) => r.replay).length, 1, "una hizo el trabajo y la otra lo repitió");
        assert.deepEqual(a.json, b.json);
        assert.equal((await items(c.id))[0].cantidad, 3);
    });

    it("la misma llave con otro cuerpo es un error del cliente (422) y no cambia nada", async () => {
        const c = await abrir();
        const k = nueva();
        assert.equal((await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1), key: k })).status, 201);
        const otra = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(5), key: k });
        assert.equal(otra.status, 422);
        assert.equal((await items(c.id))[0].cantidad, 1);
    });

    it("los errores no se guardan: tras un 400 la misma llave puede intentarse otra vez", async () => {
        const c = await abrir();
        const k = nueva();
        const vacio = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, key: k });
        assert.equal(vacio.status, 400);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pos_idempotencia WHERE clave = $1", [k])).rows[0].n, 0, "no queda reservada");
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1) });
        const bien = await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero, key: k });
        assert.equal(bien.status, 200, JSON.stringify(bien.json));
        assert.equal(bien.replay, false);
    });

    it("la llave es de cada usuario y de cada empresa: otra persona con la misma llave hace su propia acción", async () => {
        const k = nueva();
        const c1 = await abrir();
        const c2 = (await req("POST", api("/cuentas"), { token: tokMesero2, body: { tipo: "LLEVAR", personas: 1 } })).json.data;
        const a = await req("POST", api(`/cuentas/${c1.id}/items`), { token: tokMesero, body: linea(1), key: k });
        const b = await req("POST", api(`/cuentas/${c2.id}/items`), { token: tokMesero2, body: linea(1), key: k });
        assert.equal(a.replay, false);
        assert.equal(b.replay, false);
        assert.equal((await items(c1.id)).length, 1);
        assert.equal((await items(c2.id)).length, 1);
        // Otra empresa no puede repetir ni ver la respuesta guardada: ni siquiera entra a la ruta de A.
        const intruso = await req("POST", api(`/cuentas/${c1.id}/items`, A), { token: tokAdminB, body: linea(1), key: k });
        assert.equal(intruso.status, 403);
    });

    it("abrir cuenta: el reintento con la misma llave no abre otra cuenta ni consume otro folio", async () => {
        const k = nueva();
        const mesa = mesas[siguiente++ % mesas.length];
        const a = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 2 }, key: k });
        const b = await req("POST", api("/cuentas"), { token: tokMesero, body: { tipo: "MESA", mesa_id: mesa, personas: 2 }, key: k });
        assert.equal(a.status, 201);
        assert.equal(b.status, 201, "sin llave habría sido 409 por mesa ocupada");
        assert.equal(b.replay, true);
        assert.equal(b.json.data.id, a.json.data.id);
        assert.equal(b.json.data.folio, a.json.data.folio);
    });

    it("cobrar: el reintento con la misma llave devuelve el cobro original y no cobra dos veces", async () => {
        const c = await abrir();
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1) });
        await req("POST", api(`/cuentas/${c.id}/enviar`), { token: tokMesero });
        const antes = await stock((await pool.query("SELECT producto_id FROM receta_detalle WHERE receta_id = $1", [latte])).rows[0].producto_id);
        const k = nueva();
        const cuerpo = { pagos: [{ metodo: "TARJETA", monto: 58 }] };
        const a = await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: cuerpo, key: k });
        const b = await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: cuerpo, key: k });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.equal(b.status, 200, "sin llave habría sido 409 (ya cobrada)");
        assert.equal(b.replay, true);
        assert.deepEqual(b.json, a.json);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pos_pagos WHERE cuenta_id = $1", [c.id])).rows[0].n, 1, "un solo pago");
        const producto = (await pool.query("SELECT producto_id FROM receta_detalle WHERE receta_id = $1", [latte])).rows[0].producto_id;
        assert.equal(await stock(producto), antes - 1, "el inventario bajó una sola vez");
        // Sin llave, cobrar de nuevo sigue siendo 409.
        assert.equal((await req("POST", api(`/cuentas/${c.id}/cobrar`), { token: tokCajero, body: cuerpo })).status, 409);
    });

    it("una llave mal formada se rechaza", async () => {
        const c = await abrir();
        const r = await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1), key: "corta" });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /Idempotency-Key/);
    });

    it("las llaves viejas se pueden purgar sin afectar a las recientes", async () => {
        await pool.query("UPDATE pos_idempotencia SET created_at = now() - interval '3 days' WHERE empresa_id = $1", [A]);
        const c = await abrir();
        const k = nueva();
        await req("POST", api(`/cuentas/${c.id}/items`), { token: tokMesero, body: linea(1), key: k });
        await pool.query("DELETE FROM pos_idempotencia WHERE created_at < now() - interval '48 hours'");
        const quedan = (await pool.query("SELECT clave FROM pos_idempotencia WHERE empresa_id = $1", [A])).rows.map((r) => r.clave);
        assert.deepEqual(quedan, [k]);
    });
});
