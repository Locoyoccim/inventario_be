import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizarLotes, validarPreparacion, cantidadProducida, cantidadInsumo, calcularSugerencia,
} from "../src/modules/produccion/produccion.logic.js";

test("produccion: normalizarLotes acepta entero >= 1 y trunca decimales", () => {
    assert.equal(normalizarLotes("3", 1), 3);
    assert.equal(normalizarLotes(2.9, 1), 2);
});
test("produccion: normalizarLotes rechaza 0, negativos y no numéricos", () => {
    assert.throws(() => normalizarLotes(0, 1));
    assert.throws(() => normalizarLotes(-1, 1));
    assert.throws(() => normalizarLotes("abc", 1));
});

test("produccion: validarPreparacion pasa si es preparación con producto elaborado", () => {
    assert.doesNotThrow(() => validarPreparacion({ es_preparacion: true, producto_elaborado_id: 7 }, 1));
});
test("produccion: validarPreparacion rechaza recetas normales", () => {
    assert.throws(() => validarPreparacion({ es_preparacion: false, producto_elaborado_id: null }, 1));
    assert.throws(() => validarPreparacion({ es_preparacion: true, producto_elaborado_id: null }, 1));
});

test("produccion: cantidadProducida = rendimiento * lotes", () => {
    assert.equal(cantidadProducida(1000, 2), 2000);
    assert.equal(cantidadProducida("1000", 2), 2000);
    assert.equal(cantidadProducida(2.5, 2), 5);
});
test("produccion: rendimiento 0/None se trata como 1", () => {
    assert.equal(cantidadProducida(0, 3), 3);
});

test("produccion: cantidadInsumo = cantidad receta * lotes", () => {
    assert.equal(cantidadInsumo(200, 4), 800);
    assert.equal(cantidadInsumo("0.15", 2), 0.3);
});

test("produccion: sugerencia repone al mínimo en lotes enteros", () => {
    assert.deepEqual(
        calcularSugerencia(200, 500, 1000),
        { rendimiento: 1000, faltante: 300, lotes: 1, cantidad_a_producir: 1000 }
    );
});
test("produccion: sugerencia redondea lotes hacia arriba", () => {
    // faltante 500, rinde 200 => ceil(2.5)=3 lotes => 600
    assert.deepEqual(
        calcularSugerencia(0, 500, 200),
        { rendimiento: 200, faltante: 500, lotes: 3, cantidad_a_producir: 600 }
    );
});
