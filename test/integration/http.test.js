import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Pruebas de integración HTTP: requieren una BD de prueba migrada en TEST_DATABASE_URL.
// Sin esa variable se saltan (el `npm test` unitario no toca BD). Los tokens se firman
// directamente (Bearer): requireActiveUser lee rol/estado desde la BD (así se prueba A2).
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP", { skip: SKIP }, () => {
    const A = 9101, B = 9102;
    let server, base, pool, signToken;
    let tokAdminA, tokOperA, tokAdminB;
    let provId, insumoId, recetaId;

    const req = async (method, path, { token, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch { /* sin cuerpo */ }
        return { status: res.status, json };
    };

    const limpiar = async () => {
        const emp = [[A, B]];
        await pool.query("DELETE FROM conteo_detalle WHERE conteo_id IN (SELECT id FROM conteo_fisico WHERE empresa_id = ANY($1))", emp);
        await pool.query("DELETE FROM conteo_fisico WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM venta_diaria WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM compra WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", emp);
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))", emp);
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", emp);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", emp);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));

        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Emp A'),($2,'Emp B')", [A, B]);
        // 028 exige que la categoría exista en el catálogo de la empresa.
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT e, n FROM unnest($1::int[]) e, unnest($2::text[]) n ON CONFLICT DO NOTHING",
            [[A, B], ["Insumo", "Panadería", "Prep", "Preparación"]],
        );
        const mkUser = async (emp, nombre, codigo, admin, owner) => (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
            [nombre, codigo, admin, owner, emp])).rows[0].id;
        const adminAId = await mkUser(A, "AdminA", "A-adm", true, true);
        const operAId = await mkUser(A, "OperA", "A-op", false, false);
        const adminBId = await mkUser(B, "AdminB", "B-adm", true, true);
        tokAdminA = signToken({ id: adminAId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        tokOperA = signToken({ id: operAId, empresa_id: A, is_admin: false, is_owner: false, tv: 0 });
        tokAdminB = signToken({ id: adminBId, empresa_id: B, is_admin: true, is_owner: true, tv: 0 });
    });

    after(async () => {
        try { await limpiar(); } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("proveedores: soft-delete, filtro de inactivos y reactivar; 404 y 400", async () => {
        const c = await req("POST", `/api/proveedores/${A}`, { token: tokAdminA, body: { nombre: "Prov 1" } });
        assert.equal(c.status, 201);
        assert.equal(c.json.data.activo, true);
        provId = c.json.data.id;

        // DELETE = soft-delete (devuelve el proveedor desactivado)
        const d = await req("DELETE", `/api/proveedores/${A}/${provId}`, { token: tokAdminA });
        assert.equal(d.status, 200);
        assert.equal(d.json.data.activo, false);

        // Por defecto no aparece; con incluir_inactivos sí
        const l1 = await req("GET", `/api/proveedores/${A}`, { token: tokAdminA });
        assert.equal(l1.json.data.find((p) => p.id === provId), undefined);
        const l2 = await req("GET", `/api/proveedores/${A}?incluir_inactivos=true`, { token: tokAdminA });
        assert.ok(l2.json.data.find((p) => p.id === provId));

        // Crear producto con proveedor inactivo -> 400 (A8/A3)
        const pInactivo = await req("POST", `/api/productos/${A}`, {
            token: tokAdminA,
            body: { producto: "X", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 10, stock_actual: 0, stock_minimo: 0 },
        });
        assert.equal(pInactivo.status, 400);

        // Reactivar con PUT activo:true
        const r = await req("PUT", `/api/proveedores/${A}/${provId}`, { token: tokAdminA, body: { nombre: "Prov 1", activo: true } });
        assert.equal(r.json.data.activo, true);

        // DELETE inexistente -> 404 (A6)
        const nf = await req("DELETE", `/api/proveedores/${A}/999999`, { token: tokAdminA });
        assert.equal(nf.status, 404);
    });

    it("compras: cascada de costos y 4 decimales", async () => {
        // Insumo con presentación 1000 (por gramo)
        const p = await req("POST", `/api/productos/${A}`, {
            token: tokAdminA,
            body: { producto: "Harina", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1000, costo_presentacion: 10, stock_actual: 0, stock_minimo: 0 },
        });
        assert.equal(p.status, 201);
        insumoId = p.json.data.id;

        // Receta que usa el insumo (para probar la cascada)
        const rec = await req("POST", `/api/recetas/${A}`, {
            token: tokAdminA,
            body: { nombre: "Pan", categoria: "Panadería", precio_venta: 50, ingredientes: [{ producto_id: insumoId, cantidad: 200 }] },
        });
        assert.equal(rec.status, 201);
        recetaId = rec.json.data.id;

        // Compra: 1000 g por 12.30 => costo unitario 0.0123 (4 decimales)
        const compra = await req("POST", `/api/compras/${A}`, {
            token: tokAdminA,
            body: { proveedor_id: provId, referencia: "F-1", lineas: [{ producto_id: insumoId, cantidad: 1000, costo_total: 12.3 }] },
        });
        assert.equal(compra.status, 201);
        assert.equal(Number(compra.json.data.lineas[0].costo_nuevo), 0.0123, "costo unitario con 4 decimales");
        assert.ok(compra.json.data.recetas_actualizadas >= 1, "la cascada refrescó la receta");
    });

    it("recetas: guardado atómico (PUT con ingredientes)", async () => {
        const put = await req("PUT", `/api/recetas/${A}/${recetaId}`, {
            token: tokAdminA,
            body: { nombre: "Pan integral", categoria: "Panadería", precio_venta: 60, ingredientes: [{ producto_id: insumoId, cantidad: 250 }] },
        });
        assert.equal(put.status, 200);
        assert.equal(put.json.data.nombre, "Pan integral");
        assert.ok(Array.isArray(put.json.data.ingredientes));
    });

    it("conteos: registra varianza", async () => {
        // El insumo tiene stock 1000 (de la compra). Conteo físico 950 => varianza -50.
        const cnt = await req("POST", `/api/conteos/${A}`, {
            token: tokOperA,
            body: { fecha: "2026-09-16", motivo: "corte", lineas: [{ producto_id: insumoId, stock_fisico: 950 }] },
        });
        assert.equal(cnt.status, 201, "operativo puede hacer conteo");
        assert.equal(Number(cnt.json.data.detalle[0].variacion), -50);
    });

    it("producción: confirma y suma stock del elaborado", async () => {
        // Preparación (elaborado) que usa el insumo
        const prep = await req("POST", `/api/recetas/${A}`, {
            token: tokAdminA,
            body: { nombre: "Masa", categoria: "Prep", precio_venta: 0, es_preparacion: true, rendimiento: 1000, unidad: "g", stock_minimo: 100, ingredientes: [{ producto_id: insumoId, cantidad: 300 }] },
        });
        assert.equal(prep.status, 201);
        const prod = await req("POST", `/api/produccion/${A}/confirmar`, { token: tokOperA, body: { producciones: [{ receta_id: prep.json.data.id, lotes: 1 }] } });
        assert.equal(prod.status, 201, "operativo puede producir");
        assert.equal(Number(prod.json.data[0].cantidad_producida), 1000);
    });

    it("permisos: Admin vs Operativo vs otra empresa", async () => {
        // Operativo NO puede crear productos ni proveedores (escritura Admin) -> 403
        const opProd = await req("POST", `/api/productos/${A}`, {
            token: tokOperA,
            body: { producto: "Y", unidad_medida: "g", proveedor_id: provId, categoria: "Insumo", cantidad_presentacion: 1, costo_presentacion: 1, stock_actual: 0, stock_minimo: 0 },
        });
        assert.equal(opProd.status, 403, "operativo no crea productos");
        const opProv = await req("POST", `/api/proveedores/${A}`, { token: tokOperA, body: { nombre: "Z" } });
        assert.equal(opProv.status, 403, "operativo no crea proveedores");

        // Otra empresa (token B) sobre datos de A -> 403 (empresaGuard)
        const cross = await req("GET", `/api/productos/${A}`, { token: tokAdminB });
        assert.equal(cross.status, 403, "token de empresa B no accede a empresa A");
    });

    it("sesión revocada: /me responde 401 tras logout-all", async () => {
        const meId = (await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('MeUser','A-me',false,false,$1) RETURNING id",
            [A])).rows[0].id;
        const tok = signToken({ id: meId, empresa_id: A, is_admin: false, is_owner: false, tv: 0 });
        const antes = await req("GET", "/api/auth/me", { token: tok });
        assert.equal(antes.status, 200, "sesión válida ve /me");
        const all = await req("POST", "/api/auth/logout-all", { token: tok });
        assert.equal(all.status, 200);
        const despues = await req("GET", "/api/auth/me", { token: tok });
        assert.equal(despues.status, 401, "sesión revocada -> 401 en /me");
    });
});
