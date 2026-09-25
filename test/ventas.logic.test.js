import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolverPreparaciones } from "../src/modules/ventas/venta.repository.js";

// Helpers para armar el Map de preparaciones de forma legible.
const prep = (entries) => new Map(entries);
const stock = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
const cons = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

describe("resolverPreparaciones (auto-producción)", () => {
    // Salsa verde: 1 lote rinde 5000 ml y usa tomate 2000 g, cebolla 200 g, chile 50 g.
    const SALSA = 10, TOMATE = 20, CEBOLLA = 21, CHILE = 22;
    const salsaPrep = prep([
        [SALSA, {
            receta_id: 1, rendimiento: 5000, nombre: "Salsa Verde", unidad: "ml",
            detalle: [
                { producto_id: TOMATE, cantidad: 2000 },
                { producto_id: CEBOLLA, cantidad: 200 },
                { producto_id: CHILE, cantidad: 50 },
            ],
        }],
    ]);

    it("ejemplo: 6000 ml con 3500 en stock -> auto 2500 (tomate 1000, cebolla 100, chile 25)", () => {
        const { consumoFinal, autoProduccion } = resolverPreparaciones(
            cons({ [SALSA]: 6000 }),
            stock({ [SALSA]: 3500, [TOMATE]: 5000, [CEBOLLA]: 5000, [CHILE]: 5000 }),
            salsaPrep,
        );
        assert.equal(autoProduccion.length, 1);
        const ap = autoProduccion[0];
        assert.equal(ap.producto_elaborado_id, SALSA);
        assert.equal(ap.cantidad, 2500);
        assert.equal(ap.lotes_equivalentes, 0.5);
        const byId = new Map(ap.insumos.map((i) => [i.producto_id, i.cantidad]));
        assert.equal(byId.get(TOMATE), 1000);
        assert.equal(byId.get(CEBOLLA), 100);
        assert.equal(byId.get(CHILE), 25);
        // La salsa mantiene su consumo VENTA; los insumos se agregan al consumo final.
        assert.equal(consumoFinal.get(SALSA), 6000);
        assert.equal(consumoFinal.get(TOMATE), 1000);
        assert.equal(consumoFinal.get(CEBOLLA), 100);
        assert.equal(consumoFinal.get(CHILE), 25);
    });

    it("stock suficiente: sin auto-producción y los insumos no se mueven", () => {
        const { consumoFinal, autoProduccion } = resolverPreparaciones(
            cons({ [SALSA]: 6000 }),
            stock({ [SALSA]: 10000, [TOMATE]: 5000 }),
            salsaPrep,
        );
        assert.equal(autoProduccion.length, 0);
        assert.equal(consumoFinal.get(SALSA), 6000);
        assert.equal(consumoFinal.has(TOMATE), false, "el tomate no entra al consumo");
    });

    it("preparación dentro de otra preparación: resolución recursiva", () => {
        const BASE = 30, RAW = 40;
        const anidada = prep([
            [SALSA, {
                receta_id: 1, rendimiento: 5000, nombre: "Salsa", unidad: "ml",
                detalle: [{ producto_id: BASE, cantidad: 100 }],
            }],
            [BASE, {
                receta_id: 2, rendimiento: 1000, nombre: "Base", unidad: "ml",
                detalle: [{ producto_id: RAW, cantidad: 500 }],
            }],
        ]);
        const { consumoFinal, autoProduccion } = resolverPreparaciones(
            cons({ [SALSA]: 6000 }),
            stock({ [SALSA]: 0, [BASE]: 0, [RAW]: 10000 }),
            anidada,
        );
        // salsa 6000 -> base 6000*100/5000 = 120 ; base 120 -> raw 120*500/1000 = 60
        const salsaAp = autoProduccion.find((a) => a.producto_elaborado_id === SALSA);
        const baseAp = autoProduccion.find((a) => a.producto_elaborado_id === BASE);
        assert.equal(salsaAp.cantidad, 6000);
        assert.equal(baseAp.cantidad, 120);
        assert.equal(consumoFinal.get(BASE), 120);
        assert.equal(consumoFinal.get(RAW), 60);
    });

    it("ciclo entre preparaciones: error controlado", () => {
        const A = 1, B = 2;
        const ciclo = prep([
            [A, { receta_id: 1, rendimiento: 100, nombre: "A", unidad: "u", detalle: [{ producto_id: B, cantidad: 100 }] }],
            [B, { receta_id: 2, rendimiento: 100, nombre: "B", unidad: "u", detalle: [{ producto_id: A, cantidad: 100 }] }],
        ]);
        assert.throws(
            () => resolverPreparaciones(cons({ [A]: 100 }), stock({ [A]: 0, [B]: 0 }), ciclo),
            /ciclo|auto-producción/i,
        );
    });
});
