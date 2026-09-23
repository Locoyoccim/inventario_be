import { test } from "node:test";
import assert from "node:assert/strict";
import { propagarCostoInsumos } from "../src/utils/costeo.js";

// Cliente falso en memoria: solo entiende las consultas que usa la cascada de costos.
function clienteFalso({ recetas, detalle, productos }) {
    const log = [];
    return {
        log,
        async query(sql, params) {
            log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
            if (sql.includes("UPDATE receta_detalle")) {
                const ids = params[0].map(Number);
                const rows = [];
                for (const d of detalle) {
                    const p = productos[d.producto_id];
                    if (ids.includes(d.producto_id) && d.costo_unitario !== p.costo_presentacion / p.cantidad_presentacion) {
                        d.costo_unitario = p.costo_presentacion / p.cantidad_presentacion;
                        rows.push({ receta_id: d.receta_id });
                    }
                }
                return { rows };
            }
            if (sql.startsWith("SELECT precio_venta")) return { rows: [recetas[params[0]]] };
            if (sql.includes("SUM(costo_final)")) {
                const suma = detalle.filter((d) => d.receta_id === params[0]).reduce((s, d) => s + d.cantidad * d.costo_unitario, 0);
                return { rows: [{ suma }] };
            }
            if (sql.startsWith("UPDATE recetas")) {
                recetas[params[1]].costo_total = params[0];
                return { rows: [recetas[params[1]]] };
            }
            if (sql.startsWith("UPDATE productos")) {
                Object.assign(productos[params[2]], { costo_presentacion: params[0], cantidad_presentacion: params[1] });
                return { rows: [] };
            }
            throw new Error("consulta no esperada: " + sql);
        },
    };
}

const receta = (extra) => ({ precio_venta: 0, costo_produccion: 0, proteccion_pct: 0, rendimiento: 1, producto_elaborado_id: null, ...extra });

test("cascada: el costo nuevo de un insumo llega a la preparación y a la receta que la usa", async () => {
    const productos = {
        1: { costo_presentacion: 40, cantidad_presentacion: 1000 }, // harina 0.04/g (subió)
        2: { costo_presentacion: 10, cantidad_presentacion: 1000 }, // masa (elaborado de receta 10)
    };
    const recetas = { 10: receta({ rendimiento: 1000, producto_elaborado_id: 2 }), 11: receta() };
    const detalle = [
        { receta_id: 10, producto_id: 1, cantidad: 500, costo_unitario: 0.02 },
        { receta_id: 11, producto_id: 2, cantidad: 200, costo_unitario: 0.01 },
    ];
    const cli = clienteFalso({ recetas, detalle, productos });
    const tocadas = await propagarCostoInsumos(cli, [1]);
    assert.deepEqual(tocadas.sort(), [10, 11]);
    assert.equal(recetas[10].costo_total, 20);
    assert.equal(recetas[11].costo_total, 4); // 200 g * 0.02
});

test("cascada: un ciclo entre preparaciones no se queda en bucle", async () => {
    const productos = {
        1: { costo_presentacion: 5, cantidad_presentacion: 1 },
        2: { costo_presentacion: 1, cantidad_presentacion: 1 },
    };
    const recetas = {
        10: receta({ producto_elaborado_id: 2 }), // usa 1, produce 2
        11: receta({ producto_elaborado_id: 1 }), // usa 2, produce 1 (ciclo)
    };
    const detalle = [
        { receta_id: 10, producto_id: 1, cantidad: 1, costo_unitario: 1 },
        { receta_id: 11, producto_id: 2, cantidad: 1, costo_unitario: 1 },
    ];
    const cli = clienteFalso({ recetas, detalle, productos });
    const tocadas = await propagarCostoInsumos(cli, [1]);
    assert.ok(tocadas.length <= 2);
    assert.ok(cli.log.length < 50);
});

test("cascada: sin recetas afectadas no recalcula nada", async () => {
    const cli = clienteFalso({ recetas: {}, detalle: [], productos: { 1: { costo_presentacion: 1, cantidad_presentacion: 1 } } });
    assert.deepEqual(await propagarCostoInsumos(cli, [1]), []);
    assert.deepEqual(await propagarCostoInsumos(cli, []), []);
});
