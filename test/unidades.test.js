import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonizarUnidad, UNIDADES_CANONICAS } from "../src/utils/unidades.js";

describe("unidades: canonización (unitario)", () => {
    it("mapea variantes comunes a la forma canónica", () => {
        assert.equal(canonizarUnidad("gr"), "g");
        assert.equal(canonizarUnidad("Gramos"), "g");
        assert.equal(canonizarUnidad("  G "), "g");
        assert.equal(canonizarUnidad("KG"), "kg");
        assert.equal(canonizarUnidad("kilos"), "kg");
        assert.equal(canonizarUnidad("Mililitros"), "ml");
        assert.equal(canonizarUnidad("Litros"), "l");
        assert.equal(canonizarUnidad("lt"), "l");
        assert.equal(canonizarUnidad("pza"), "pieza");
        assert.equal(canonizarUnidad("Unidades"), "pieza");
        assert.equal(canonizarUnidad("porción"), "porcion");
        assert.equal(canonizarUnidad("raciones"), "porcion");
    });

    it("acepta las canónicas tal cual", () => {
        for (const u of UNIDADES_CANONICAS) assert.equal(canonizarUnidad(u), u);
    });

    it("devuelve null para desconocidas o vacías", () => {
        assert.equal(canonizarUnidad("xyz"), null);
        assert.equal(canonizarUnidad(""), null);
        assert.equal(canonizarUnidad("   "), null);
        assert.equal(canonizarUnidad(null), null);
    });
});
