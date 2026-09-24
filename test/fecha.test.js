import test from "node:test";
import assert from "node:assert/strict";
import { hoyISO, noFutura, esFechaReal } from "../src/utils/fecha.js";

test("hoyISO respeta la zona horaria del negocio", () => {
    const t = new Date("2026-09-24T05:00:00Z"); // 23:00 del 23 en México (UTC-6)
    assert.equal(hoyISO(t, "America/Mexico_City"), "2026-09-23");
    assert.equal(hoyISO(t, "UTC"), "2026-09-24");
});

test("noFutura: mañana en hora de México se considera futuro (400)", () => {
    const t = new Date("2026-09-24T05:00:00Z");
    assert.equal(noFutura("2026-09-24", t), false); // sería mañana en México
    assert.equal(noFutura("2026-09-23", t), true);
});

test("esFechaReal rechaza fechas inexistentes", () => {
    assert.equal(esFechaReal("2026-02-31"), false);
    assert.equal(esFechaReal("2026-02-28"), true);
});
