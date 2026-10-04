import test from "node:test";
import assert from "node:assert/strict";
import { areaSugerida } from "../src/modules/pos/pos.areas.js";

test("areaSugerida: categorías de bebidas van a Barra (con acentos, plural y varias palabras)", () => {
    for (const nombre of ["Bebidas", "bebida", "Café", "Cafés calientes", "Té e infusiones", "Jugos", "Cervezas", "Vinos y licores", "Coctelería", "Refrescos", "Agua", "Barra", "Smoothies"])
        assert.equal(areaSugerida(nombre), "Barra", nombre);
});

test("areaSugerida: lo demás no tiene sugerencia (va al área por defecto)", () => {
    for (const nombre of ["Platillos", "Postres", "Desayunos", "Ensaladas", "Pasteles", "Entradas", "Insumos secos", "Tendencias", "Sándwiches"])
        assert.equal(areaSugerida(nombre), null, nombre);
});
