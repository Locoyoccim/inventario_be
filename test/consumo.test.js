import test from "node:test";
import assert from "node:assert/strict";
import { calcularConsumo } from "../src/modules/ventas/venta.repository.js";
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

test("consumo: RECETA con factor equivale a renglón con cantidad * factor", () => {
    const detalle = [{ receta_id: 1, producto_id: 10, cantidad: 0.35 }];
    const merma = new Map([[10, 12.5]]);
    const porPos = calcularConsumo([{ nombre_pos: "X", cantidad: 3 }], [{ nombre_pos: "X", tipo: "RECETA", receta_id: 1, factor: 1.5 }], detalle, merma);
    const porRenglon = explotarRenglones([{ receta_id: 1, cantidad: 4.5 }], detalle, merma);
    assert.equal(porPos.consumo.get(10), porRenglon.consumo.get(10));
});

test("consumo: una RECETA explota a sus insumos por la cantidad vendida", () => {
    const posMap = [{ nombre_pos: "Chilaquiles", tipo: "RECETA", receta_id: 1, factor: 1 }];
    const detalle = [
        { receta_id: 1, producto_id: 10, cantidad: 200 },
        { receta_id: 1, producto_id: 11, cantidad: 120 },
    ];
    const { consumo } = calcularConsumo([{ nombre_pos: "Chilaquiles", cantidad: 4 }], posMap, detalle);
    assert.equal(consumo.get(10), 800);
    assert.equal(consumo.get(11), 480);
});

test("consumo: un INSUMO mapeado descuenta directo, con factor", () => {
    const posMap = [{ nombre_pos: "Servilletas", tipo: "INSUMO", producto_id: 20, factor: 2 }];
    const { consumo } = calcularConsumo([{ nombre_pos: "Servilletas", cantidad: 3 }], posMap, []);
    assert.equal(consumo.get(20), 6);
});

test("consumo: IGNORAR no consume y queda registrado", () => {
    const posMap = [{ nombre_pos: "Propina", tipo: "IGNORAR" }];
    const { consumo, ignorados } = calcularConsumo([{ nombre_pos: "Propina", cantidad: 5 }], posMap, []);
    assert.equal(consumo.size, 0);
    assert.equal(ignorados.length, 1);
});

test("consumo: línea sin mapeo se reporta en sin_mapeo", () => {
    const { consumo, sin_mapeo } = calcularConsumo([{ nombre_pos: "Desconocido", cantidad: 2 }], [], []);
    assert.equal(consumo.size, 0);
    assert.equal(sin_mapeo[0].nombre_pos, "Desconocido");
});

test("consumo: RECETA sin escandallo se reporta y no consume", () => {
    const posMap = [{ nombre_pos: "Sopa", tipo: "RECETA", receta_id: 9, factor: 1 }];
    const { consumo, recetas_sin_escandallo } = calcularConsumo([{ nombre_pos: "Sopa", cantidad: 3 }], posMap, []);
    assert.equal(consumo.size, 0);
    assert.equal(recetas_sin_escandallo[0].receta_id, 9);
});

test("consumo: el match ignora acentos y mayúsculas", () => {
    const posMap = [{ nombre_pos: "Café Con Leche", tipo: "INSUMO", producto_id: 30, factor: 1 }];
    const { consumo } = calcularConsumo([{ nombre_pos: "cafe con leche", cantidad: 2 }], posMap, []);
    assert.equal(consumo.get(30), 2);
});

test("consumo: dos líneas que usan el mismo insumo se acumulan", () => {
    const posMap = [
        { nombre_pos: "Taco", tipo: "RECETA", receta_id: 1, factor: 1 },
        { nombre_pos: "Quesadilla", tipo: "RECETA", receta_id: 2, factor: 1 },
    ];
    const detalle = [
        { receta_id: 1, producto_id: 50, cantidad: 30 },
        { receta_id: 2, producto_id: 50, cantidad: 40 },
    ];
    const { consumo } = calcularConsumo(
        [{ nombre_pos: "Taco", cantidad: 2 }, { nombre_pos: "Quesadilla", cantidad: 1 }],
        posMap, detalle
    );
    assert.equal(consumo.get(50), 2 * 30 + 1 * 40); // 100
});
