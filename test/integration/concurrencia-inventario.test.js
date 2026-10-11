import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Auditoría · integridad de operaciones: inventario, compras y producción ante solicitudes simultáneas y repetidas.
// Cada prueba comprueba el ESTADO FINAL DE LA BASE (existencias, kardex, documentos), no solo el código HTTP.
//
// Invariantes del kardex (movimientosinventario) que se verifican en todas:
//   · cadena: el stock_anterior de cada movimiento es el stock_nuevo del anterior (ningún movimiento "se pisa" con otro);
//   · cierre: el stock_nuevo del último movimiento es el stock_actual del inventario;
//   · el stock nunca es negativo.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integridad — inventario, compras y producción con concurrencia", { skip: SKIP }, () => {
    const A = 9951;
    let server, base, pool, tok, provId, seq;

    const req = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                Authorization: `Bearer ${tok}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* vacío */
        }
        return { status: res.status, json, texto };
    };
    const detalle = (rs) => rs.map((r) => `${r.status}: ${r.texto.slice(0, 160)}`).join("\n");
    const cuenta = (rs) => {
        const por = {};
        for (const r of rs) por[r.status] = (por[r.status] ?? 0) + 1;
        return por;
    };
    const mkInsumo = async (nombre, stock) => {
        const r = await req("POST", `/api/productos/${A}`, {
            producto: `${nombre}-${++seq}`,
            unidad_medida: "g",
            proveedor_id: provId,
            categoria: "Insumo",
            cantidad_presentacion: 1,
            costo_presentacion: 2,
            stock_actual: stock,
            stock_minimo: 0,
        });
        assert.equal(r.status, 201, r.texto);
        return r.json.data.id;
    };
    const stockDe = async (pid) =>
        Number(
            (await pool.query("SELECT stock_actual FROM inventario WHERE producto_id = $1", [pid]))
                .rows[0].stock_actual,
        );
    const maxMov = async (pid) =>
        Number(
            (
                await pool.query(
                    "SELECT coalesce(max(id),0) m FROM movimientosinventario WHERE producto_id = $1",
                    [pid],
                )
            ).rows[0].m,
        );

    // Kardex del producto desde un punto (id de movimiento): verifica la cadena y que cierre con el inventario.
    const verificarKardex = async (pid, desdeId, stockInicial) => {
        const { rows } = await pool.query(
            "SELECT id, stock_anterior, stock_nuevo FROM movimientosinventario WHERE producto_id = $1 AND id > $2 ORDER BY id",
            [pid, desdeId],
        );
        let esperado = stockInicial;
        for (const m of rows) {
            assert.equal(
                Number(m.stock_anterior),
                esperado,
                `kardex roto en el movimiento ${m.id}: la cadena no empata`,
            );
            assert.ok(Number(m.stock_nuevo) >= 0, `stock negativo en el movimiento ${m.id}`);
            esperado = Number(m.stock_nuevo);
        }
        assert.equal(
            esperado,
            await stockDe(pid),
            "el último movimiento no cierra con el inventario",
        );
        return rows.length;
    };

    // Garantiza que las peticiones lleguen JUNTAS al punto de la carrera: la prueba retiene el inventario del producto, lanza todas las
    // peticiones (que avanzan hasta toparse con ese bloqueo), espera a que se acumulen y recién entonces lo suelta. Sin esto, la
    // anulación doble "pasa" por casualidad de tiempos aunque se le quite el bloqueo de la cabecera.
    const retenido = async (pid, lanzar) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            await c.query("SELECT 1 FROM inventario WHERE producto_id = $1 FOR UPDATE", [pid]);
            const pendientes = lanzar();
            await new Promise((r) => setTimeout(r, 500));
            await c.query("COMMIT");
            return await Promise.all(pendientes);
        } finally {
            c.release();
        }
    };

    const limpiar = async () => {
        const e = [[A]];
        await pool.query(
            "DELETE FROM compra_detalle WHERE compra_id IN (SELECT id FROM compra WHERE empresa_id = ANY($1))",
            e,
        );
        await pool.query("DELETE FROM compra WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM produccion WHERE empresa_id = ANY($1)", e);
        await pool.query(
            "DELETE FROM receta_detalle WHERE receta_id IN (SELECT id FROM recetas WHERE empresa_id = ANY($1))",
            e,
        );
        await pool.query("DELETE FROM recetas WHERE empresa_id = ANY($1)", e);
        await pool.query(
            "DELETE FROM movimientosinventario WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = ANY($1))",
            e,
        );
        await pool.query("DELETE FROM inventario WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM productos WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM proveedores WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM categorias WHERE empresa_id = ANY($1)", e);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", e);
    };

    before(async () => {
        seq = 0;
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Concurrencia')", [A]);
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT $1, n FROM unnest($2::text[]) n ON CONFLICT DO NOTHING",
            [A, ["Insumo", "Prep"]],
        );
        const adminId = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','CI-adm',true,true,$1) RETURNING id",
                [A],
            )
        ).rows[0].id;
        tok = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        provId = (await req("POST", `/api/proveedores/${A}`, { nombre: "Prov" })).json.data.id;
    });

    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    describe("movimientos de inventario", () => {
        it("25 mermas de 1 a la vez sobre 10 en existencia: exactamente 10 se aplican, 15 se rechazan y el stock queda en 0", async () => {
            const pid = await mkInsumo("Merma", 10);
            const desde = await maxMov(pid);
            const rs = await Promise.all(
                Array.from({ length: 25 }, () =>
                    req("POST", `/api/productos/${A}/${pid}/movimientos`, {
                        tipo_movimiento: "MERMA",
                        cantidad: 1,
                        motivo: "prueba",
                    }),
                ),
            );
            assert.deepEqual(cuenta(rs), { 201: 10, 400: 15 }, detalle(rs));
            assert.equal(await stockDe(pid), 0, "el stock no puede quedar negativo ni sobrante");
            assert.equal(
                await verificarKardex(pid, desde, 10),
                10,
                "un movimiento por cada merma aceptada, ninguno por las rechazadas",
            );
        });

        it("entradas y salidas mezcladas en paralelo: la existencia final es la suma exacta y el kardex encadena", async () => {
            const pid = await mkInsumo("Mezcla", 100);
            const desde = await maxMov(pid);
            const peticiones = [
                ...Array.from({ length: 8 }, () => ({
                    tipo_movimiento: "DEVOLUCION",
                    cantidad: 3,
                })), // +24
                ...Array.from({ length: 8 }, () => ({ tipo_movimiento: "MERMA", cantidad: 2 })), // -16
                ...Array.from({ length: 4 }, () => ({ tipo_movimiento: "AJUSTE", cantidad: 5 })), // +20
                ...Array.from({ length: 4 }, () => ({ tipo_movimiento: "AJUSTE", cantidad: -1 })), // -4
            ];
            const rs = await Promise.all(
                peticiones.map((b) =>
                    req("POST", `/api/productos/${A}/${pid}/movimientos`, {
                        ...b,
                        motivo: "prueba",
                    }),
                ),
            );
            assert.deepEqual(cuenta(rs), { 201: 24 }, detalle(rs));
            assert.equal(await stockDe(pid), 100 + 24 - 16 + 20 - 4);
            assert.equal(await verificarKardex(pid, desde, 100), 24);
        });
    });

    describe("compras", () => {
        const pedido = async (pid, cantidad = 10, costo_total = 20) => {
            const r = await req("POST", `/api/compras/${A}/pedido`, {
                lineas: [{ producto_id: pid, cantidad, costo_total }],
            });
            assert.equal(r.status, 201, r.texto);
            return r.json.data.id ?? r.json.data.compra?.id;
        };
        const movsCompra = async (pid, compraId, ref) =>
            Number(
                (
                    await pool.query(
                        "SELECT count(*)::int n FROM movimientosinventario WHERE producto_id = $1 AND referencia_tipo = $2 AND referencia_id = $3",
                        [pid, ref, compraId],
                    )
                ).rows[0].n,
            );

        it("recibir el mismo pedido 6 veces a la vez: se recibe una sola vez, el resto es 409, y el stock sube solo una vez", async () => {
            const pid = await mkInsumo("Recibir", 50);
            const desde = await maxMov(pid);
            const compraId = await pedido(pid, 10, 20);
            const rs = await Promise.all(
                Array.from({ length: 6 }, () =>
                    req("POST", `/api/compras/${A}/${compraId}/recibir`, {}),
                ),
            );
            const buenas = rs.filter((r) => r.status >= 200 && r.status < 300);
            assert.equal(buenas.length, 1, detalle(rs));
            assert.equal(rs.filter((r) => r.status === 409).length, 5, detalle(rs));
            assert.equal(await stockDe(pid), 60, "la compra suma una sola vez");
            assert.equal(await movsCompra(pid, compraId, "COMPRA"), 1, "un solo movimiento COMPRA");
            assert.equal(await verificarKardex(pid, desde, 50), 1);
            const c = (
                await pool.query("SELECT estado, anulado FROM compra WHERE id = $1", [compraId])
            ).rows[0];
            assert.equal(c.estado, "RECIBIDA");
            assert.equal(c.anulado, false);
        });

        it("anular una compra recibida 6 veces a la vez: se revierte una sola vez y el stock vuelve al de antes", async () => {
            const pid = await mkInsumo("Anular", 50);
            const compraId = await pedido(pid, 10, 20);
            assert.ok(
                (await req("POST", `/api/compras/${A}/${compraId}/recibir`, {})).status < 300,
            );
            assert.equal(await stockDe(pid), 60);
            const desde = await maxMov(pid);
            const rs = await retenido(pid, () =>
                Array.from({ length: 6 }, () =>
                    req("POST", `/api/compras/${A}/${compraId}/anular`, { motivo: "duplicada" }),
                ),
            );
            assert.equal(
                rs.filter((r) => r.status >= 200 && r.status < 300).length,
                1,
                detalle(rs),
            );
            assert.equal(rs.filter((r) => r.status === 409).length, 5, detalle(rs));
            assert.equal(await stockDe(pid), 50, "la reversa se aplica una sola vez");
            assert.equal(
                await movsCompra(pid, compraId, "COMPRA_ANULADA"),
                1,
                "una sola reversa en el kardex",
            );
            assert.equal(await verificarKardex(pid, desde, 60), 1);
        });

        it("recibir y anular el mismo pedido a la vez: gane quien gane, el stock y el estado son coherentes", async () => {
            const pid = await mkInsumo("Carrera", 50);
            const compraId = await pedido(pid, 10, 20);
            const desde = await maxMov(pid);
            const rs = await Promise.all([
                req("POST", `/api/compras/${A}/${compraId}/recibir`, {}),
                req("POST", `/api/compras/${A}/${compraId}/anular`, { motivo: "carrera" }),
            ]);
            assert.ok(
                rs.every((r) => r.status < 500),
                detalle(rs),
            );
            const c = (
                await pool.query("SELECT estado, anulado FROM compra WHERE id = $1", [compraId])
            ).rows[0];
            const stock = await stockDe(pid);
            // Anulada ⇒ nada suma al stock (o se sumó y se revirtió). Recibida y no anulada ⇒ suma 10. Nunca otra cosa.
            assert.equal(
                stock,
                c.anulado ? 50 : c.estado === "RECIBIDA" ? 60 : 50,
                `estado ${JSON.stringify(c)} con stock ${stock}\n${detalle(rs)}`,
            );
            await verificarKardex(pid, desde, 50);
        });
    });

    describe("producción", () => {
        // Preparación "Masa": cada lote consume 300 g del insumo y rinde 1000 g del elaborado.
        const preparacion = async (nombre, insumos, rendimiento = 1000) => {
            const r = await req("POST", `/api/recetas/${A}`, {
                nombre: `${nombre}-${++seq}`,
                categoria: "Prep",
                precio_venta: 0,
                es_preparacion: true,
                rendimiento,
                unidad: "g",
                stock_minimo: 0,
                ingredientes: insumos.map(([producto_id, cantidad]) => ({ producto_id, cantidad })),
            });
            assert.equal(r.status, 201, r.texto);
            const id = r.json.data.id;
            const elab = (
                await pool.query("SELECT producto_elaborado_id FROM recetas WHERE id = $1", [id])
            ).rows[0].producto_elaborado_id;
            return { id, elaborado: Number(elab) };
        };
        const producir = (items) =>
            req("POST", `/api/produccion/${A}/confirmar`, { producciones: items });
        const nProducciones = async () =>
            Number(
                (
                    await pool.query(
                        "SELECT count(*)::int n FROM produccion WHERE empresa_id = $1",
                        [A],
                    )
                ).rows[0].n,
            );

        it("6 producciones simultáneas con insumo para 3: se confirman 3, se rechazan 3, sin cabeceras ni movimientos huérfanos", async () => {
            const insumo = await mkInsumo("Harina", 1000);
            const masa = await preparacion("Masa", [[insumo, 300]]);
            const antes = await nProducciones();
            const dI = await maxMov(insumo);
            const dE = await maxMov(masa.elaborado);
            const rs = await Promise.all(
                Array.from({ length: 6 }, () => producir([{ receta_id: masa.id, lotes: 1 }])),
            );
            assert.deepEqual(cuenta(rs), { 201: 3, 400: 3 }, detalle(rs));
            assert.equal(await stockDe(insumo), 100, "1000 − 3×300");
            assert.equal(await stockDe(masa.elaborado), 3000, "3 lotes × 1000");
            assert.equal(
                (await nProducciones()) - antes,
                3,
                "las producciones rechazadas no dejan cabecera",
            );
            assert.equal(await verificarKardex(insumo, dI, 1000), 3);
            assert.equal(await verificarKardex(masa.elaborado, dE, 0), 3);
        });

        it("anular la misma producción 6 veces a la vez: se revierte una sola vez (insumo y elaborado)", async () => {
            const insumo = await mkInsumo("Azúcar", 1000);
            const masa = await preparacion("Dulce", [[insumo, 300]]);
            // Dos producciones: así el elaborado tiene existencia de sobra y SOLO el bloqueo de la cabecera impide revertir dos veces
            // (con una sola producción, la segunda reversa se frenaría sola por "dejaría stock negativo" y el bloqueo no se probaría).
            const p1 = await producir([{ receta_id: masa.id, lotes: 1 }]);
            const p2 = await producir([{ receta_id: masa.id, lotes: 1 }]);
            assert.equal(p1.status, 201, p1.texto);
            assert.equal(p2.status, 201, p2.texto);
            const produccionId = p1.json.data[0].produccion_id;
            assert.equal(await stockDe(insumo), 400);
            assert.equal(await stockDe(masa.elaborado), 2000);
            const rs = await retenido(insumo, () =>
                Array.from({ length: 6 }, () =>
                    req("POST", `/api/produccion/${A}/${produccionId}/anular`, {
                        motivo: "duplicada",
                    }),
                ),
            );
            assert.equal(
                rs.filter((r) => r.status >= 200 && r.status < 300).length,
                1,
                detalle(rs),
            );
            assert.equal(rs.filter((r) => r.status === 409).length, 5, detalle(rs));
            assert.equal(
                await stockDe(insumo),
                700,
                "el insumo de la producción anulada vuelve una sola vez",
            );
            assert.equal(
                await stockDe(masa.elaborado),
                1000,
                "el elaborado de esa producción se descuenta una sola vez",
            );
            const anuladas = (
                await pool.query(
                    "SELECT count(*)::int n FROM produccion WHERE empresa_id = $1 AND anulado",
                    [A],
                )
            ).rows[0].n;
            assert.ok(anuladas >= 1);
        });

        it("dos producciones en una sola petición, pedidas en orden opuesto por dos cajeros: sin interbloqueo (nunca 500) y sin stock negativo", async () => {
            // Masa y Salsa usan insumos DISTINTOS. La petición 1 produce [Masa, Salsa] y la 2 [Salsa, Masa]: si cada una bloqueara sus
            // insumos en el orden en que llegan, una tendría el insumo de Masa y esperaría el de Salsa mientras la otra hace lo contrario,
            // y la base abortaría una con deadlock (40P01 → 500).
            const insumoA = await mkInsumo("BaseA", 100000);
            const insumoB = await mkInsumo("BaseB", 100000);
            const masa = await preparacion("MasaX", [[insumoA, 100]], 1000);
            const salsa = await preparacion("SalsaX", [[insumoB, 50]], 500);
            const rs = [];
            for (let ronda = 0; ronda < 10; ronda++) {
                rs.push(
                    ...(await Promise.all([
                        producir([
                            { receta_id: masa.id, lotes: 1 },
                            { receta_id: salsa.id, lotes: 1 },
                        ]),
                        producir([
                            { receta_id: salsa.id, lotes: 1 },
                            { receta_id: masa.id, lotes: 1 },
                        ]),
                        producir([
                            { receta_id: masa.id, lotes: 1 },
                            { receta_id: salsa.id, lotes: 1 },
                        ]),
                        producir([
                            { receta_id: salsa.id, lotes: 1 },
                            { receta_id: masa.id, lotes: 1 },
                        ]),
                    ])),
                );
            }
            assert.ok(
                rs.every((r) => r.status < 500),
                `hubo errores del servidor (¿deadlock?):\n${detalle(rs.filter((r) => r.status >= 500).slice(0, 3))}`,
            );
            // Lo confirmado cuadra con lo consumido: 40 peticiones, todas con insumo de sobra.
            const buenas = rs.filter((r) => r.status === 201).length;
            assert.equal(await stockDe(insumoA), 100000 - buenas * 100);
            assert.equal(await stockDe(insumoB), 100000 - buenas * 50);
            assert.equal(await stockDe(masa.elaborado), buenas * 1000);
            assert.equal(await stockDe(salsa.elaborado), buenas * 500);
        });
    });
});
