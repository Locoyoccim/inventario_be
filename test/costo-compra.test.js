import test from "node:test";
import assert from "node:assert/strict";
import { costoUltimaCompra } from "../src/modules/compras/compra.logic.js";

test("compra: último costo = precio de la última compra (no promedia)", () => {
    assert.equal(costoUltimaCompra(0.04), 0.04);
    assert.equal(costoUltimaCompra("0.055"), 0.055);
});
