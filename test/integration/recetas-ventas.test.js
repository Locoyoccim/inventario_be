import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

import { borrarVentaCsv, sembrarVentaCsv } from "../helpers/ventaHistorica.js";
import { iniciarServidor } from "../helpers/servidor.js";

describe("Integración HTTP — Recetas: ventas por receta (mezcla + costo % ponderado)", { skip: SKIP }, () => {
    const A = 9701, B = 9702;
    let server, base, pool, signToken, tokAdmin, tokOper, tokAdminB, provId, cafeId, latteId, americanoId;

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
        const e = [[A, B]];
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", e);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Ventas A'),($2,'Ventas B')", [A, B]);
        // 028 exige que la categoría exista en el catálogo de la empresa.
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n ON CONFLICT DO NOTHING",
            [[A, B], ["Insumo", "Bebidas"]],
        );
        const mk = async (emp, nombre, cod, admin) => (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ($1,$2,$3,$3,$4) RETURNING id",
            [nombre, cod, admin, emp])).rows[0].id;
        tokAdmin = signToken({ id: await mk(A, "AdmA", "VA-adm", true), empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        tokOper = signToken({ id: await mk(A, "OpA", "VA-op", false), empresa_id: A, is_admin: false, is_owner: false, tv: 0 });
        tokAdminB = signToken({ id: await mk(B, "AdmB", "VB-adm", true), empresa_id: B, is_admin: true, is_owner: true, tv: 0 });

        provId = (await req("POST", `/api/proveedores/${A}`, { token: tokAdmin, body: { nombre: "Prov" } })).json.data.id;
        cafeId = (await req("POST", `/api/productos/${A}`, { token: tokAdmin, body: { producto: "Café", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1, costo_presentacion: 5, stock_actual: 100000, stock_minimo: 0 } })).json.data.id;
        // Latte: precio 116 con IVA 16% incluido -> neto 100; costo_total 5 (1×café)
        latteId = (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body: { nombre: "Latte", categoria: "Bebidas", precio_venta: 116, iva_pct: 16, precio_incluye_iva: true, ingredientes: [{ producto_id: cafeId, cantidad: 1 }] } })).json.data.id;
        // Americano: precio 100 SIN IVA incluido -> neto 100; costo_total 10 (2×café)
        americanoId = (await req("POST", `/api/recetas/${A}`, { token: tokAdmin, body: { nombre: "Americano", categoria: "Bebidas", precio_venta: 100, iva_pct: 16, precio_incluye_iva: false, ingredientes: [{ producto_id: cafeId, cantidad: 2 }] } })).json.data.id;
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("mezcla de dos días con dos recetas: unidades, ingreso, neto y costo % ponderado (prueba 1)", async () => {
        await sembrarVentaCsv(pool, A, "2026-08-01", [{ receta_id: latteId, cantidad: 2, precio_unitario: 116 }, { receta_id: americanoId, cantidad: 3, precio_unitario: 100 }]);
        await sembrarVentaCsv(pool, A, "2026-08-02", [{ receta_id: latteId, cantidad: 1, precio_unitario: 116 }]);

        const r = await req("GET", `/api/recetas/${A}/ventas?desde=2026-08-01&hasta=2026-08-02`, { token: tokAdmin });
        assert.equal(r.status, 200);
        assert.equal(r.json.data.dias_importados, 2);
        const byId = new Map(r.json.data.recetas.map((x) => [x.receta_id, x]));
        const latte = byId.get(latteId);
        assert.equal(latte.unidades, 3);
        assert.equal(latte.ingreso, 348);       // 3 × 116
        assert.equal(latte.ingreso_neto, 300);  // 3 × 100 (IVA 16% incluido)
        assert.equal(latte.costo_teorico, 15);  // 3 × 5
        assert.equal(latte.costo_pct, 5);       // 15/300
        const ame = byId.get(americanoId);
        assert.equal(ame.unidades, 3);
        assert.equal(ame.ingreso, 300);
        assert.equal(ame.ingreso_neto, 300);    // precio_incluye_iva=false -> neto = precio
        assert.equal(ame.costo_teorico, 30);
        // Totales ponderados
        const t = r.json.data.totales;
        assert.equal(t.unidades, 6);
        assert.equal(t.ingreso, 648);
        assert.equal(t.ingreso_neto, 600);
        assert.equal(t.costo_teorico, 45);
        assert.equal(t.costo_pct, 7.5);          // 45/600
        assert.equal(t.utilidad, 555);
        // Orden por unidades desc, empate -> nombre asc (Americano antes que Latte)
        assert.equal(r.json.data.recetas[0].nombre, "Americano");
        // limpiar
        await borrarVentaCsv(pool, A, "2026-08-01");
        await borrarVentaCsv(pool, A, "2026-08-02");
    });

    it("precio_unitario null usa precio_venta (prueba 2)", async () => {
        await sembrarVentaCsv(pool, A, "2026-08-05", [{ receta_id: latteId, cantidad: 2, precio_unitario: null }]);
        const r = await req("GET", `/api/recetas/${A}/ventas?desde=2026-08-05&hasta=2026-08-05`, { token: tokAdmin });
        const latte = r.json.data.recetas.find((x) => x.receta_id === latteId);
        assert.equal(latte.ingreso, 232);       // 2 × 116 (usa r.precio_venta)
        assert.equal(latte.ingreso_neto, 200);
        await borrarVentaCsv(pool, A, "2026-08-05");
    });

    it("un día sin ventas no cuenta (prueba 3)", async () => {
        const r = await req("GET", `/api/recetas/${A}/ventas?desde=2026-08-07&hasta=2026-08-07`, { token: tokAdmin });
        assert.equal(r.json.data.dias_importados, 0);
        assert.deepEqual(r.json.data.recetas, []);
        assert.equal(r.json.data.totales.costo_pct, null);
    });

    it("permisos: Operativo 403; otra empresa no ve los datos (prueba 4)", async () => {
        assert.equal((await req("GET", `/api/recetas/${A}/ventas`, { token: tokOper })).status, 403);
        assert.ok([403, 404].includes((await req("GET", `/api/recetas/${A}/ventas`, { token: tokAdminB })).status));
    });

    it("rango inválido o mayor a 366 días -> 400 con details (prueba 5)", async () => {
        const inv = await req("GET", `/api/recetas/${A}/ventas?desde=2026-08-10&hasta=2026-08-01`, { token: tokAdmin });
        assert.equal(inv.status, 400);
        assert.ok(inv.json.details, "incluye details");
        const big = await req("GET", `/api/recetas/${A}/ventas?desde=2024-01-01&hasta=2026-01-01`, { token: tokAdmin });
        assert.equal(big.status, 400);
    });

    it("líneas SIN_MAPEO/INSUMO van en sin_receta, no en recetas (prueba 6)", async () => {
        await sembrarVentaCsv(pool, A, "2026-08-12", [{ producto_id: cafeId, cantidad: 5 }, { nombre_pos: "Desconocido", cantidad: 2 }]);
        const r = await req("GET", `/api/recetas/${A}/ventas?desde=2026-08-12&hasta=2026-08-12`, { token: tokAdmin });
        assert.deepEqual(r.json.data.recetas, [], "ninguna receta");
        assert.equal(r.json.data.sin_receta.lineas, 2);
        assert.equal(r.json.data.sin_receta.unidades, 7);
        await borrarVentaCsv(pool, A, "2026-08-12");
    });
});
