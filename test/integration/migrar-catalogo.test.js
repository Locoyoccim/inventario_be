import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { iniciarServidor } from "../helpers/servidor.js";
import { leerOrigen, migrar, validarPlan } from "../../scripts/migrar_catalogo.js";

// Migración del catálogo (proveedores, categorías, productos) entre dos empresas por la API real: aquí origen y destino son dos empresas de
// la misma base de pruebas, y el «destino» es la app levantada en memoria.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Migración del catálogo por la API (migrar:catalogo)", { skip: SKIP }, () => {
    const O = 9651; // origen
    const D = 9652; // destino
    const sufijo = `${Date.now().toString(36)}${process.pid}`;
    const EMAIL = `dueno-${sufijo}@migrar.test`;
    const CLAVE = "ClaveDePrueba123";
    let server, base, pool;

    const limpiar = async () => {
        const e = [[O, D]];
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query(
            "DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))",
            e,
        );
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };
    const contar = async (tabla, empresa) =>
        (await pool.query(`SELECT count(*)::int n FROM ${tabla} WHERE empresa_id = $1`, [empresa]))
            .rows[0].n;
    const opciones = (extra = {}) => ({
        db: pool,
        origenEmpresa: O,
        destino: base,
        destinoEmpresa: D,
        email: EMAIL,
        password: CLAVE,
        ...extra,
    });

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Origen'),($2,'Destino')", [
            O,
            D,
        ]);
        await pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,email,password_hash,is_admin,is_owner,empresa_id) VALUES ('Dueño','MC-own',$1,$2,true,true,$3)",
            [EMAIL, await bcrypt.hash(CLAVE, 4), D],
        );
        // Origen: 2 proveedores (uno sin productos), 2 categorías, y productos: activo, inactivo, elaborado, con máximo inválido.
        const pv = (n) =>
            pool
                .query(
                    "INSERT INTO proveedores (nombre,telefono,empresa_id) VALUES ($1,'555',$2) RETURNING id",
                    [n, O],
                )
                .then((r) => r.rows[0].id);
        const p1 = await pv("Lácteos del Valle");
        await pv("Proveedor sin productos");
        await pool.query(
            "INSERT INTO categorias (empresa_id,nombre,tipo) VALUES ($1,'Lácteos','PRODUCTO'),($1,'Bebidas','AMBAS')",
            [O],
        );
        const prod = async (nombre, extra = {}) => {
            const r = await pool.query(
                `INSERT INTO productos (producto,unidad_medida,proveedor_id,categoria,empresa_id,cantidad_presentacion,costo_presentacion,merma_pct,es_elaborado,activo,precio_venta)
                 VALUES ($1,$2,$3,$4,$5,1000,50,5,$6,$7,$8) RETURNING id`,
                [
                    nombre,
                    "g",
                    p1,
                    "Lácteos",
                    O,
                    extra.elaborado ?? false,
                    extra.activo ?? true,
                    extra.precio ?? null,
                ],
            );
            await pool.query(
                "INSERT INTO inventario (producto_id,empresa_id,stock_actual,stock_minimo,stock_maximo) VALUES ($1,$2,$3,$4,$5)",
                [r.rows[0].id, O, extra.stock ?? 7, extra.min ?? 2, extra.max ?? 10],
            );
        };
        await prod("Leche entera", { precio: 30 });
        await prod("Queso añejo", { max: 1, min: 2 }); // máximo ≤ mínimo: se lleva sin máximo
        await prod("Crema vieja", { activo: false });
        await prod("Salsa de la casa", { elaborado: true });
    });
    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("la simulación lee y valida, pero no escribe nada ni contacta el destino", async () => {
        const r = await migrar(
            opciones({
                aplicar: false,
                destino: "http://127.0.0.1:1" /* nadie escucha: si lo intentara, fallaría */,
            }),
        );
        assert.equal(r.aplicado, false);
        assert.deepEqual(r.problemas, []);
        assert.equal(r.plan.productos, 2);
        assert.equal(r.plan.proveedores, 1, "el proveedor sin productos no se lleva");
        assert.equal(r.plan.categorias, 2);
        assert.deepEqual(r.plan.omitidos.map((o) => o.motivo).sort(), [
            "elaborado (nace de una receta)",
            "inactivo",
        ]);
        assert.equal(await contar("productos", D), 0);
    });

    it("aplicar crea proveedores, categorías y productos en el destino con el stock en cero y conserva mínimo, máximo y precio", async () => {
        const r = await migrar(opciones({ aplicar: true }));
        assert.deepEqual(r.errores, []);
        assert.deepEqual(r.creados, { proveedores: 1, categorias: 2, productos: 2 });
        assert.equal(await contar("productos", D), 2);
        const leche = (
            await pool.query(
                "SELECT p.*, i.stock_actual, i.stock_minimo, i.stock_maximo FROM productos p JOIN inventario i ON i.producto_id=p.id WHERE p.empresa_id=$1 AND p.producto='Leche entera'",
                [D],
            )
        ).rows[0];
        assert.equal(Number(leche.stock_actual), 0, "stock inicial en cero");
        assert.equal(Number(leche.stock_minimo), 2);
        assert.equal(Number(leche.stock_maximo), 10);
        assert.equal(Number(leche.precio_venta), 30);
        assert.equal(Number(leche.costo_presentacion), 50);
        const queso = (
            await pool.query(
                "SELECT i.stock_maximo FROM productos p JOIN inventario i ON i.producto_id=p.id WHERE p.empresa_id=$1 AND p.producto='Queso añejo'",
                [D],
            )
        ).rows[0];
        assert.equal(queso.stock_maximo, null, "un máximo que no supera al mínimo se omite");
        const prov = (
            await pool.query(
                "SELECT proveedor_id FROM productos WHERE empresa_id=$1 AND producto='Leche entera'",
                [D],
            )
        ).rows[0].proveedor_id;
        assert.equal(
            (await pool.query("SELECT empresa_id, nombre FROM proveedores WHERE id=$1", [prov]))
                .rows[0].empresa_id,
            D,
            "el proveedor es de la empresa destino",
        );
        assert.equal(await contar("productos", O), 4, "el origen no se toca");
    });

    it("es repetible: una segunda corrida no duplica nada", async () => {
        const r = await migrar(opciones({ aplicar: true }));
        assert.deepEqual(r.errores, []);
        assert.deepEqual(r.creados, { proveedores: 0, categorias: 0, productos: 0 });
        assert.deepEqual(r.existian, { proveedores: 1, categorias: 2, productos: 2 });
        assert.equal(await contar("productos", D), 2);
        assert.equal(await contar("proveedores", D), 1);
    });

    it("con --incluir-inactivos lleva también los desactivados y los deja inactivos", async () => {
        const r = await migrar(opciones({ aplicar: true, incluirInactivos: true }));
        assert.deepEqual(r.errores, []);
        assert.equal(r.creados.productos, 1);
        const crema = (
            await pool.query(
                "SELECT activo FROM productos WHERE empresa_id=$1 AND producto='Crema vieja'",
                [D],
            )
        ).rows[0];
        assert.equal(crema.activo, false);
    });

    it("una contraseña incorrecta o una empresa ajena se rechazan sin escribir nada", async () => {
        await assert.rejects(
            migrar(opciones({ aplicar: true, password: "otra-clave-123" })),
            /No se pudo ingresar/,
        );
        await assert.rejects(
            migrar(opciones({ aplicar: true, destinoEmpresa: O })),
            /no tiene acceso|empresa/i,
        );
    });

    it("rechaza un destino que no es https (salvo localhost)", async () => {
        await assert.rejects(
            migrar(opciones({ aplicar: true, destino: "http://ejemplo.mx" })),
            /https/,
        );
    });

    it("la validación rechaza un plan con producto de categoría inexistente o datos que la API no aceptaría", async () => {
        const plan = await leerOrigen(pool, O, { incluirInactivos: true });
        plan.categorias = plan.categorias.filter((c) => c.nombre !== "Lácteos");
        plan.productos[0].body.cantidad_presentacion = 0;
        const problemas = validarPlan(plan);
        assert.ok(problemas.some((p) => /categoría «Lácteos» no está/.test(p)));
        assert.ok(problemas.some((p) => /cantidad_presentacion/.test(p)));
    });
});
