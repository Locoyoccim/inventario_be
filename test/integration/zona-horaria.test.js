import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — zona horaria por empresa", { skip: SKIP }, () => {
    const MX = 9471; // America/Mexico_City (default)
    const ES = 9472; // Europe/Madrid
    let server, base, pool, signToken, tokMx, tokEs;

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

    const limpiar = async () => {
        const e = [[MX, ES]];
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    const mkAdmin = async (empresa, codigo) => {
        const id = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ($1,$1,true,true,$2) RETURNING id",
            [codigo, empresa],
        )).rows[0].id;
        return signToken({ id, empresa_id: empresa, is_admin: true, is_owner: true, tv: 0 });
    };

    // Un movimiento en el instante "20:30 del 10-mar-2026 en México", guardado como lo hace la base
    // (timestamp sin zona en la hora de la sesión). Allá es 10-mar; en Madrid ya es 11-mar.
    const mkMovimiento = async (empresa) => {
        await pool.query("INSERT INTO categorias (empresa_id, nombre) VALUES ($1,'sin categoria')", [empresa]);
        const p = (await pool.query(
            "INSERT INTO productos (empresa_id, producto, cantidad_presentacion, costo_presentacion) VALUES ($1,'Prod zona',1,10) RETURNING id",
            [empresa],
        )).rows[0].id;
        await pool.query("INSERT INTO inventario (producto_id, empresa_id, stock_actual) VALUES ($1,$2,5)", [p, empresa]);
        await pool.query(
            `INSERT INTO movimientosinventario (producto_id, tipo_movimiento, cantidad, costo_unitario, stock_anterior, stock_nuevo, fecha)
             VALUES ($1,'VENTA',1,10,6,5, ('2026-03-10 20:30'::timestamp AT TIME ZONE 'America/Mexico_City') AT TIME ZONE current_setting('TimeZone'))`,
            [p],
        );
    };

    const ventasEn = async (token, empresa, dia) => {
        const r = await req("GET", `/api/reportes/${empresa}/actividad?desde=${dia}&hasta=${dia}`, { token });
        assert.equal(r.status, 200);
        return r.json.data.por_tipo.find((x) => x.tipo === "VENTA")?.num_movimientos ?? 0;
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Zona MX'), ($2,'Zona ES')", [MX, ES]);
        tokMx = await mkAdmin(MX, "ZH-mx");
        tokEs = await mkAdmin(ES, "ZH-es");
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("la zona por defecto es America/Mexico_City y se puede cambiar por empresa", async () => {
        const g = await req("GET", `/api/empresas/${MX}/configuracion`, { token: tokMx });
        assert.equal(g.json.data.zona_horaria, "America/Mexico_City");
        const u = await req("PUT", `/api/empresas/${ES}/configuracion`, { token: tokEs, body: { zona_horaria: "Europe/Madrid" } });
        assert.equal(u.status, 200);
        assert.equal(u.json.data.zona_horaria, "Europe/Madrid");
    });

    it("rechaza una zona que Postgres no conoce", async () => {
        const r = await req("PUT", `/api/empresas/${MX}/configuracion`, { token: tokMx, body: { zona_horaria: "Marte/Olympus" } });
        assert.equal(r.status, 400);
        const g = await req("GET", `/api/empresas/${MX}/configuracion`, { token: tokMx });
        assert.equal(g.json.data.zona_horaria, "America/Mexico_City");
    });

    it("el mismo instante cae en días distintos según la zona de cada empresa", async () => {
        await mkMovimiento(MX);
        await mkMovimiento(ES);
        assert.equal(await ventasEn(tokMx, MX, "2026-03-10"), 1);
        assert.equal(await ventasEn(tokMx, MX, "2026-03-11"), 0);
        assert.equal(await ventasEn(tokEs, ES, "2026-03-10"), 0);
        assert.equal(await ventasEn(tokEs, ES, "2026-03-11"), 1);
    });

    it("los demás endpoints con rango de fechas responden bien (historial, consumo, kardex)", async () => {
        for (const ruta of [
            `/api/reportes/${MX}/historial?desde=2026-03-01&hasta=2026-03-31&limit=10&offset=0`,
            `/api/reportes/${MX}/consumo?desde=2026-03-01&hasta=2026-03-31`,
            `/api/reportes/${MX}/estado?fecha=2026-03-10`,
            `/api/movimientos/${MX}?desde=2026-03-10&hasta=2026-03-10&limit=10`,
            `/api/finanzas/${MX}/resumen?desde=2026-03-01&hasta=2026-03-31&agrupar=dia`,
        ]) {
            const r = await req("GET", ruta, { token: tokMx });
            assert.equal(r.status, 200, `${ruta} -> ${r.status} ${JSON.stringify(r.json)}`);
        }
        const k = await req("GET", `/api/movimientos/${MX}?desde=2026-03-10&hasta=2026-03-10&limit=10`, { token: tokMx });
        const kEs = await req("GET", `/api/movimientos/${ES}?desde=2026-03-10&hasta=2026-03-10&limit=10`, { token: tokEs });
        assert.equal(k.json.data.length, 1, "kardex México: el movimiento cae el 10");
        assert.equal(kEs.json.data.length, 0, "kardex Madrid: el mismo instante ya es el 11");
    });

    it("fecha_negocio no depende de la zona del servidor", async () => {
        const c = await pool.connect();
        try {
            await c.query("SET TimeZone = 'UTC'");
            const utc = (await c.query("SELECT fecha_negocio('2026-10-04 01:30'::timestamp, 'America/Mexico_City')::text AS d")).rows[0].d;
            await c.query("SET TimeZone = 'America/Mexico_City'");
            const mx = (await c.query("SELECT fecha_negocio('2026-10-03 19:30'::timestamp, 'America/Mexico_City')::text AS d")).rows[0].d;
            assert.equal(utc, "2026-10-03"); // 01:30 UTC del 4 = 19:30 del 3 en México
            assert.equal(mx, "2026-10-03");
        } finally {
            c.release();
        }
    });
});
