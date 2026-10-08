import test from "node:test";
import assert from "node:assert/strict";
import { comparar, estaDesactualizado, leerManifiesto } from "../src/modules/pos/agente.manifiesto.js";

const HASH = "a".repeat(64);

test("comparar: versiones semánticas (no por texto)", () => {
    assert.equal(comparar("1.6.0", "1.6.0"), 0);
    assert.equal(comparar("1.6.0", "1.10.0"), -1);
    assert.equal(comparar("2.0.0", "1.99.99"), 1);
});

test("leerManifiesto: sin versión no hay manifiesto; sin hash o sin https no se publica la descarga", () => {
    assert.equal(leerManifiesto({}), null);
    assert.equal(leerManifiesto({ AGENTE_ULTIMA_VERSION: "latest" }), null);
    const solo = leerManifiesto({ AGENTE_ULTIMA_VERSION: "1.7.0" });
    assert.deepEqual(solo, { version: "1.7.0", minima: null, url: null, sha256: null, instalador: null });
    // URL sin https o hash inválido: el agente no descargaría algo que no puede verificar
    assert.equal(leerManifiesto({ AGENTE_ULTIMA_VERSION: "1.7.0", AGENTE_URL_DESCARGA: "http://x.test/a.exe", AGENTE_SHA256: HASH }).url, null);
    assert.equal(leerManifiesto({ AGENTE_ULTIMA_VERSION: "1.7.0", AGENTE_URL_DESCARGA: "https://x.test/a.exe", AGENTE_SHA256: "zz" }).url, null);
    const completo = leerManifiesto({
        AGENTE_ULTIMA_VERSION: "1.7.0", AGENTE_VERSION_MINIMA: "1.6.0", AGENTE_URL_DESCARGA: "https://x.test/agente.exe",
        AGENTE_SHA256: HASH.toUpperCase(), AGENTE_INSTALADOR_URL: "https://x.test/setup.exe",
    });
    assert.deepEqual(completo, { version: "1.7.0", minima: "1.6.0", url: "https://x.test/agente.exe", sha256: HASH, instalador: "https://x.test/setup.exe" });
});

test("estaDesactualizado", () => {
    const m = { version: "1.7.0" };
    assert.equal(estaDesactualizado("1.6.0", m), true);
    assert.equal(estaDesactualizado("1.7.0", m), false);
    assert.equal(estaDesactualizado("1.8.0", m), false);
    assert.equal(estaDesactualizado(null, m), false);
    assert.equal(estaDesactualizado("1.6.0", null), false);
});
