import test from "node:test";
import assert from "node:assert/strict";
import { costoUltimaCompra, normalizarLineaCompra, costoPresentacionDesde } from "../src/modules/compras/compra.logic.js";

test("compra: último costo = precio de la última compra (no promedia)", () => {
    assert.equal(costoUltimaCompra(0.04), 0.04);
    assert.equal(costoUltimaCompra("0.055"), 0.055);
});

test("compra: normalizarLineaCompra deriva precio desde costo_total", () => {
    assert.deepEqual(normalizarLineaCompra({ producto_id: 1, cantidad: 2000, costo_total: 60 }),
        { cantidad: 2000, costoTotal: 60, precioCompra: 0.03 });
});
test("compra: normalizarLineaCompra deriva costo_total desde costo_unitario", () => {
    assert.deepEqual(normalizarLineaCompra({ producto_id: 1, cantidad: 500, costo_unitario: 0.05 }),
        { cantidad: 500, costoTotal: 25, precioCompra: 0.05 });
});
test("compra: normalizarLineaCompra rechaza cantidad <= 0 y costo negativo", () => {
    assert.throws(() => normalizarLineaCompra({ producto_id: 1, cantidad: 0, costo_total: 10 }));
    assert.throws(() => normalizarLineaCompra({ producto_id: 1, cantidad: 5, costo_total: -1 }));
});

test("compra: costoPresentacionDesde = costo_unitario * cantidad_presentacion (2 dec)", () => {
    assert.equal(costoPresentacionDesde(0.03, 1000), 30);
    assert.equal(costoPresentacionDesde(0.021046, 1000), 21.05);
});
