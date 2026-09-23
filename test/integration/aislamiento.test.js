import test from "node:test";
import assert from "node:assert/strict";

// Test de integración: requiere una BD de prueba migrada en TEST_DATABASE_URL.
// Sin esa variable se salta (el `npm test` unitario no toca BD).
const DB = process.env.TEST_DATABASE_URL;
if (DB) process.env.DATABASE_URL = DB;

test("D5: aislamiento multiempresa (ninguna empresa ve datos de otra)", { skip: !DB && "define TEST_DATABASE_URL para correrlo" }, async () => {
    const { default: pool } = await import("../../src/config/db.js");
    const { default: ProductoRepository } = await import("../../src/modules/productos/productos.repository.js");
    const { default: RecetaRepository } = await import("../../src/modules/recetas/receta.repository.js");
    const repoP = new ProductoRepository();
    const repoR = new RecetaRepository();
    const A = 9001, B = 9002;

    // Limpieza idempotente + fixtures de dos empresas
    await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))", [[A, B]]);
    await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Empresa A'),($2,'Empresa B')", [A, B]);

    const mkProd = async (emp, nombre) => (await pool.query(
        "INSERT INTO productos (producto,unidad_medida,categoria,empresa_id,cantidad_presentacion,costo_presentacion) VALUES ($1,'u','X',$2,1,10) RETURNING id",
        [nombre, emp])).rows[0].id;
    const pA = await mkProd(A, "SoloA");
    const pB = await mkProd(B, "SoloB");
    await pool.query("INSERT INTO inventario (producto_id,stock_actual,stock_minimo,empresa_id) VALUES ($1,5,0,$2),($3,5,0,$4)", [pA, A, pB, B]);
    await pool.query("INSERT INTO recetas (nombre,categoria,precio_venta,empresa_id) VALUES ('RecA','X',10,$1),('RecB','X',10,$2)", [A, B]);

    // Productos: A solo ve lo suyo
    const listaA = await repoP.findAll(A);
    assert.equal(listaA.total, 1);
    assert.equal(listaA.rows[0].producto, "SoloA");

    // findById cruzado: el producto de B no es visible con la empresa A
    assert.equal(await repoP.findById(pB, A), undefined);
    assert.ok(await repoP.findById(pB, B), "B sí ve su propio producto");

    // Recetas: A solo ve las suyas
    const recA = await repoR.findAll(A);
    assert.equal(recA.total, 1);
    assert.equal(recA.rows[0].nombre, "RecA");

    // Limpieza
    await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", [[A, B]]);
    await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    await pool.end();
});
