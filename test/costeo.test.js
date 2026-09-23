import test from "node:test";
import assert from "node:assert/strict";
import { costoTotal, margen } from "../src/utils/costeo.js";

test("costeo: costoTotal sin producción ni protección = suma de insumos", () => {
    assert.equal(costoTotal({ sumaInsumos: 27 }), 27);
});

test("costeo: costoTotal suma producción antes de protección", () => {
    assert.equal(costoTotal({ sumaInsumos: 20, costoProduccion: 5 }), 25);
});

test("costeo: protección se aplica sobre (insumos + producción)", () => {
    assert.equal(costoTotal({ sumaInsumos: 90, costoProduccion: 10, proteccionPct: 20 }), 120);
});

test("costeo: defaults (todo 0) => 0", () => {
    assert.equal(costoTotal({}), 0);
});

test("costeo: acepta strings numéricos (vienen de la BD)", () => {
    assert.equal(costoTotal({ sumaInsumos: "10", costoProduccion: "5", proteccionPct: "0" }), 15);
});

test("costeo: margen = (precio - costo) / precio * 100", () => {
    assert.equal(margen(100, 40), 60);
});

test("costeo: margen con precio 0 => 0 (sin división por cero)", () => {
    assert.equal(margen(0, 40), 0);
});

test("costeo: margen negativo cuando el costo supera el precio", () => {
    assert.equal(margen(10, 15), -50);
});
