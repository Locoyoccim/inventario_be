import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — endpoints retirados (Toteat y rutas sin uso)", { skip: SKIP }, () => {
    const E = 9511;
    let server, base, pool, tok;

    const req = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return res.status;
    };

    const limpiar = async () => {
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        server = appMod.default.listen(0);
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Retirados')", [E]);
        const id = (await pool.query("INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('RT-own','RT-own',true,true,$1) RETURNING id", [E])).rows[0].id;
        tok = signToken({ id, empresa_id: E, is_admin: true, is_owner: true, tv: 0 });
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("la importación del CSV de Toteat y su mapeo ya no existen", async () => {
        for (const [m, ruta, body] of [
            ["GET", `/api/ventas/${E}`], ["POST", `/api/ventas/${E}/importar`, { fecha: "2026-01-01", lineas: [] }], ["POST", `/api/ventas/${E}/preview`, { lineas: [] }],
            ["DELETE", `/api/ventas/${E}/2026-01-01`], ["GET", `/api/ventas/${E}/dias-pos`],
            ["GET", `/api/pos-map/${E}`], ["POST", `/api/pos-map/${E}`, { nombre_pos: "x", tipo: "IGNORAR" }],
            ["POST", `/api/finanzas/${E}/ingresos/lote`, { fecha: "2026-01-01", lineas: [{ metodo_pago: "EFECTIVO", monto: 1 }] }],
        ]) assert.equal(await req(m, ruta, body), 404, `${m} ${ruta}`);
    });

    it("rutas sin consumidor retiradas: inventario, escritura de ingredientes y CRUD de /empresas", async () => {
        for (const [m, ruta, body] of [
            ["GET", `/api/inventario/${E}`], ["GET", `/api/inventario/${E}/1`],
            ["POST", `/api/recetas/${E}/detalle`, { producto_id: 1, cantidad: 1 }],
            ["GET", "/api/empresas"], ["GET", `/api/empresas/${E}`], ["PUT", `/api/empresas/${E}`, { nombre: "x" }], ["DELETE", `/api/empresas/${E}`],
            ["GET", `/api/usuarios/${E}/1`], ["DELETE", `/api/usuarios/${E}/1`], ["GET", `/api/proveedores/${E}/1`],
        ]) assert.equal(await req(m, ruta, body), 404, `${m} ${ruta}`);
    });

    it("los ingredientes de una receta (GET /recetas/:id/detalle) siguen y respetan la empresa", async () => {
        const otra = (await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Retirados B') RETURNING id", [E + 1])).rows[0].id;
        await pool.query("INSERT INTO categorias (empresa_id, nombre) VALUES ($1,'Platillos'), ($2,'Platillos')", [otra, E]);
        try {
            const rec = (await pool.query("INSERT INTO recetas (empresa_id, nombre, categoria, precio_venta) VALUES ($1,'Receta B','Platillos',10) RETURNING id", [otra])).rows[0].id;
            assert.equal(await req("GET", `/api/recetas/${rec}/detalle`), 403, "una receta de otra empresa no se ve");
            assert.equal(await req("GET", `/api/recetas/99999999/detalle`), 404);
            await pool.query("DELETE FROM recetas WHERE empresa_id = $1", [otra]);
            const mia = (await pool.query("INSERT INTO recetas (empresa_id, nombre, categoria, precio_venta) VALUES ($1,'Receta A','Platillos',10) RETURNING id", [E])).rows[0].id;
            assert.equal(await req("GET", `/api/recetas/${mia}/detalle`), 200);
            await pool.query("DELETE FROM recetas WHERE empresa_id = $1", [E]);
        } finally {
            await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", [[otra, E]]);
            await pool.query("DELETE FROM empresas WHERE id = $1", [otra]);
        }
    });

    it("lo que sí sigue: configuración de la empresa, usuarios, proveedores, recetas y el ingreso individual", async () => {
        assert.equal(await req("GET", `/api/empresas/${E}/configuracion`), 200);
        assert.equal(await req("GET", `/api/usuarios/${E}`), 200);
        assert.equal(await req("GET", `/api/proveedores/${E}`), 200);
        assert.equal(await req("GET", `/api/recetas/${E}`), 200);
        assert.equal(await req("POST", `/api/recetas/${E}/preview`, { ingredientes: [{ producto_id: 1, cantidad: 1 }] }) !== 404, true, "el costo en vivo del formulario de receta sigue");
        assert.equal(await req("POST", `/api/finanzas/${E}/ingresos`, { fecha: "2026-01-01", metodo_pago: "EFECTIVO", monto: 10 }), 201);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = $1", [E]);
    });
});
