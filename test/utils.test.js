import test from "node:test";
import assert from "node:assert/strict";
import { normalizar } from "../src/utils/normalize.js";
import { parsePagination } from "../src/utils/pagination.js";
import { parseToteatCsv } from "../src/utils/parseToteat.js";

test("normalize: minúsculas, sin acentos, espacios colapsados", () => {
    assert.equal(normalizar("  Café   Con  Leche "), "cafe con leche");
});
test("normalize: null/undefined => cadena vacía", () => {
    assert.equal(normalizar(null), "");
    assert.equal(normalizar(undefined), "");
});

test("pagination: defaults 50/0 cuando no hay query", () => {
    assert.deepEqual(parsePagination({}), { limit: 50, offset: 0 });
});
test("pagination: parsea limit/offset válidos", () => {
    assert.deepEqual(parsePagination({ limit: "10", offset: "5" }), { limit: 10, offset: 5 });
});
test("pagination: limit inválido o <=0 cae al default", () => {
    assert.equal(parsePagination({ limit: "0" }).limit, 50);
    assert.equal(parsePagination({ limit: "abc" }).limit, 50);
});
test("pagination: limit se topa en maxLimit", () => {
    assert.equal(parsePagination({ limit: "9999" }).limit, 200);
});
test("pagination: offset negativo => 0", () => {
    assert.equal(parsePagination({ offset: "-3" }).offset, 0);
});

test("parseToteat: usa la columna Total, ignora header/TOTAL/Propinas", () => {
    const csv = [
        "Productos,Ana,Beto,Total",
        "Latte,1.00,2.00,3.00",
        "Chilaquiles,2.00,2.00,4.00",
        "TOTAL,3.00,4.00,7.00",
        "Propinas,$0.00,$165.00,$165.00",
    ].join("\n");
    const filas = parseToteatCsv(csv);
    assert.deepEqual(filas, [
        { nombre_pos: "Latte", cantidad: 3 },
        { nombre_pos: "Chilaquiles", cantidad: 4 },
    ]);
});
test("parseToteat: descarta filas con Total 0 o vacío", () => {
    const csv = ["Productos,Ana,Total", "Agua,0.00,0.00", "Te,1.00,1.00"].join("\n");
    assert.deepEqual(parseToteatCsv(csv), [{ nombre_pos: "Te", cantidad: 1 }]);
});
