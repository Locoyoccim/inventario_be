import test from "node:test";
import assert from "node:assert/strict";
import { explotarRenglones } from "../src/utils/consumo.js";

test("renglones: receta explota con merma y producto directo sin merma", () => {
    const detalle = [{ receta_id: 1, producto_id: 10, cantidad: 100 }];
    const merma = new Map([[10, 8], [20, 50]]);
    const { consumo } = explotarRenglones(
        [{ receta_id: 1, cantidad: 2 }, { producto_id: 20, cantidad: 3 }],
        detalle,
        merma,
    );
    assert.equal(consumo.get(10), Number((200 / (1 - 0.08)).toFixed(3)));
    assert.equal(consumo.get(20), 3);
});

test("renglones: mismo producto vendido directo y dentro de receta se suma", () => {
    const detalle = [{ receta_id: 1, producto_id: 30, cantidad: 1 }];
    const { consumo } = explotarRenglones([{ receta_id: 1, cantidad: 2 }, { producto_id: 30, cantidad: 1 }], detalle);
    assert.equal(consumo.get(30), 3);
});

test("renglones: receta sin escandallo se devuelve intacta y no consume", () => {
    const { consumo, recetas_sin_escandallo } = explotarRenglones([{ receta_id: 7, cantidad: 1, item_id: 99 }], []);
    assert.equal(consumo.size, 0);
    assert.equal(recetas_sin_escandallo[0].item_id, 99);
});
