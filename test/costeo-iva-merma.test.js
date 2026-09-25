import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { factorMerma, netoABruto, costoUtil, round5, enriquecerReceta } from "../src/utils/costeo.js";

describe("costeo: IVA y merma (unitario)", () => {
    it("factorMerma / netoABruto / costoUtil", () => {
        assert.equal(factorMerma(0), 1);
        assert.equal(factorMerma(8).toFixed(6), (1 / 0.92).toFixed(6));
        // Aguacate $200/1000g, merma 8% -> costo_util 0.2174
        assert.equal(costoUtil(0.2, 8), 0.2174);
        // 100 g netos con 8% -> 108.696 g brutos
        assert.equal(netoABruto(100, 8), 108.696);
        assert.equal(netoABruto(100, 0), 100);
    });

    it("round5: al múltiplo de $5 más cercano", () => {
        assert.equal(round5(135.33), 135);
        assert.equal(round5(137.6), 140);
        assert.equal(round5(112.5), 115); // .5 redondea hacia arriba
    });

    it("enriquecerReceta: precio $110, IVA 16%, costo $35 (prueba 1)", () => {
        const r = enriquecerReceta(
            { precio_venta: 110, iva_pct: 16, precio_incluye_iva: true, costo_total: 35 },
            30
        );
        assert.equal(r.precio_neto, 94.83);
        assert.equal(r.iva_monto, 15.17);
        assert.equal(r.costo_pct, 36.91);
        assert.equal(r.utilidad, 59.83);
        assert.equal(r.precio_sugerido, 135);
    });

    it("enriquecerReceta: precio_incluye_iva=false -> neto = precio", () => {
        const r = enriquecerReceta(
            { precio_venta: 100, iva_pct: 16, precio_incluye_iva: false, costo_total: 30 },
            30
        );
        assert.equal(r.precio_neto, 100);
        assert.equal(r.iva_monto, 0);
    });
});
