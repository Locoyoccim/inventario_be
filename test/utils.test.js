import test from "node:test";
import assert from "node:assert/strict";
import { normalizar } from "../src/utils/normalize.js";
import { parsePagination } from "../src/utils/pagination.js";

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
