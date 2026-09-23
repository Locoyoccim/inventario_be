import test from "node:test";
import assert from "node:assert/strict";
import { parseFiltrosProductos } from "../src/modules/productos/productos.logic.js";

test("filtros: defaults sin query (solo activos, sin filtros)", () => {
    assert.deepEqual(parseFiltrosProductos({}), { q: null, categoria: null, bajoMinimo: false, incluirInactivos: false });
});
test("filtros: recorta y normaliza q y categoria", () => {
    const f = parseFiltrosProductos({ q: "  tomate ", categoria: " Verdura " });
    assert.equal(f.q, "tomate");
    assert.equal(f.categoria, "Verdura");
});
test("filtros: banderas aceptan 'true'/'1'", () => {
    assert.equal(parseFiltrosProductos({ bajo_minimo: "true" }).bajoMinimo, true);
    assert.equal(parseFiltrosProductos({ incluir_inactivos: "1" }).incluirInactivos, true);
    assert.equal(parseFiltrosProductos({ bajo_minimo: "no" }).bajoMinimo, false);
});
