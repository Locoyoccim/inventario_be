import test from "node:test";
import assert from "node:assert/strict";
import { validarLineasConteo, resumirVarianza } from "../src/modules/conteos/conteo.logic.js";

test("conteo: validarLineasConteo acepta productos distintos", () => {
    assert.doesNotThrow(() => validarLineasConteo([{ producto_id: 1 }, { producto_id: 2 }]));
});
test("conteo: validarLineasConteo rechaza vacío", () => {
    assert.throws(() => validarLineasConteo([]));
});
test("conteo: validarLineasConteo rechaza producto repetido", () => {
    assert.throws(() => validarLineasConteo([{ producto_id: 1 }, { producto_id: 1 }]));
});

test("conteo: resumirVarianza separa merma y sobrante con sus valores", () => {
    const detalle = [
        { variacion: -150, valor_variacion: -3.75 }, // merma
        { variacion: 0, valor_variacion: 0 },        // sin cambio
        { variacion: 20, valor_variacion: 1.80 },    // sobrante
    ];
    assert.deepEqual(resumirVarianza(detalle), {
        lineas: 3, con_merma: 1, con_sobrante: 1,
        valor_merma: -3.75, valor_sobrante: 1.8, valor_neto: -1.95,
    });
});
