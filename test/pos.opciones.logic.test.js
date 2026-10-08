import { test } from "node:test";
import assert from "node:assert/strict";
import { consumoDeOpciones, nombresOpciones, precioConExtras, validarSeleccion } from "../src/modules/pos/pos.opciones.logic.js";

const grupos = [
    { id: 1, nombre: "Término", minimo: 1, maximo: 1, modificadores: [{ id: 11, nombre: "Medio", precio_extra: 0 }, { id: 12, nombre: "Bien cocido", precio_extra: 0 }] },
    { id: 2, nombre: "Extras", minimo: 0, maximo: 2, modificadores: [{ id: 21, nombre: "Extra queso", precio_extra: "15.50", producto_id: 7, cantidad: "30" }, { id: 22, nombre: "Aguacate", precio_extra: 20 }, { id: 23, nombre: "Tocino", precio_extra: 18 }] },
];

test("opciones: una selección válida devuelve el snapshot ordenado y el extra por pieza", () => {
    const r = validarSeleccion(grupos, [22, 11, 21]);
    assert.deepEqual(r.opciones.map((o) => o.id), [11, 21, 22]);
    assert.equal(r.extra, 35.5);
    assert.deepEqual(r.opciones[1], { id: 21, grupo: "Extras", nombre: "Extra queso", precio_extra: 15.5, producto_id: 7, cantidad: 30 });
    assert.equal(r.opciones[0].producto_id, null);
});

test("opciones: respeta mínimos y máximos de cada grupo con mensajes claros", () => {
    assert.throws(() => validarSeleccion(grupos, []), /Elige una opción de «Término»/);
    assert.throws(() => validarSeleccion(grupos, [11, 12]), /«Término» admite una sola opción/);
    assert.throws(() => validarSeleccion(grupos, [11, 21, 22, 23]), /«Extras» admite hasta 2 opciones/);
    assert.throws(() => validarSeleccion([{ ...grupos[1], minimo: 2 }], [21]), /al menos 2 de «Extras»/);
});

test("opciones: una opción que no pertenece al artículo (o ya no existe) se rechaza", () => {
    assert.throws(() => validarSeleccion(grupos, [11, 999]), /ya no está disponible/);
    assert.throws(() => validarSeleccion([], [11]), /ya no está disponible/, "un artículo sin grupos no admite opciones");
    assert.deepEqual(validarSeleccion([], []), { opciones: [], extra: 0 });
});

test("opciones: repetir un id no duplica la opción", () => {
    assert.equal(validarSeleccion(grupos, [11, 22, 22]).opciones.length, 2);
});

test("opciones: el precio con extras no arrastra errores de punto flotante", () => {
    assert.equal(precioConExtras(0.1, 0.2), 0.3);
    assert.equal(precioConExtras(120, 35.5), 155.5);
});

test("opciones: el consumo de insumos va por pieza vendida y ignora lo cancelado", () => {
    const items = [
        { estado: "ENVIADO", cantidad: 3, opciones: [{ producto_id: 7, cantidad: 30 }, { producto_id: null, cantidad: null }] },
        { estado: "ENVIADO", cantidad: 1, opciones: [{ producto_id: 7, cantidad: 30 }, { producto_id: 8, cantidad: 0.5 }] },
        { estado: "CANCELADO", cantidad: 5, opciones: [{ producto_id: 7, cantidad: 30 }] },
        { estado: "PENDIENTE", cantidad: 2, opciones: [] },
    ];
    const c = consumoDeOpciones(items);
    assert.equal(c.get(7), 120);
    assert.equal(c.get(8), 0.5);
    assert.equal(c.size, 2);
});

test("opciones: nombres para imprimir", () => {
    assert.deepEqual(nombresOpciones([{ nombre: "Medio" }, { nombre: "Extra queso" }]), ["Medio", "Extra queso"]);
    assert.deepEqual(nombresOpciones(undefined), []);
});
