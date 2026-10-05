import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "secreto-de-prueba";

const { validarPin, hashPin, verificarPin, esperaSeg, esperaTotalSeg, superaBloqueoDuro, generarCodigo, normalizarCodigo, hashCodigo, LIMITES } =
    await import("../src/modules/auth/pin.logic.js");
const { puedeAutorizarUsuario } = await import("../src/modules/pos/pos.autorizacion.js");

test("validarPin: 4 a 6 dígitos, sin repetidos ni secuencias", () => {
    assert.equal(validarPin("4827"), null);
    assert.equal(validarPin("739104"), null);
    assert.equal(validarPin("2468"), null);
    assert.match(validarPin("123"), /4 a 6/);
    assert.match(validarPin("1234567"), /4 a 6/);
    assert.match(validarPin("12a4"), /4 a 6/);
    assert.match(validarPin("0000"), /repetir/);
    assert.match(validarPin("1234"), /secuencia/);
    assert.match(validarPin("654321"), /secuencia/);
    assert.equal(validarPin(1234), "El PIN debe tener de 4 a 6 dígitos");
});

test("hashPin: no guarda el PIN, depende del usuario y se verifica", async () => {
    const h1 = await hashPin(1, "4827");
    const h2 = await hashPin(2, "4827");
    assert.ok(h1.startsWith("$2"));
    assert.ok(!h1.includes("4827"));
    assert.notEqual(h1, h2);
    assert.equal(await verificarPin(1, "4827", h1), true);
    assert.equal(await verificarPin(1, "4828", h1), false);
    // el hash de otro usuario no sirve aunque el PIN sea el mismo (la semilla incluye el id)
    assert.equal(await verificarPin(2, "4827", h1), false);
    // sin hash se compara contra un dummy y nunca acepta
    assert.equal(await verificarPin(1, "4827", null), false);
});

test("esperaSeg: enfría al llegar al máximo y se libera pasado el tiempo", () => {
    const l = LIMITES.usuarioDispositivo;
    const ahora = 1_000_000;
    assert.equal(esperaSeg({ n: l.max - 1, ultimoMs: ahora }, l, ahora), 0);
    assert.equal(esperaSeg({ n: l.max, ultimoMs: ahora }, l, ahora), l.enfriaSeg);
    assert.equal(esperaSeg({ n: l.max, ultimoMs: ahora - 100_000 }, l, ahora), l.enfriaSeg - 100);
    assert.equal(esperaSeg({ n: l.max + 3, ultimoMs: ahora - (l.enfriaSeg + 1) * 1000 }, l, ahora), 0);
    assert.equal(esperaSeg({ n: 0, ultimoMs: null }, l, ahora), 0);
});

test("esperaTotalSeg: manda el enfriamiento más largo; superaBloqueoDuro cuenta la ventana larga", () => {
    const ahora = 5_000_000;
    const libre = { n: 0, ultimoMs: null };
    assert.equal(esperaTotalSeg({ usuarioDispositivo: libre, dispositivo: libre, ip: libre }, ahora), 0);
    const lleno = { n: LIMITES.dispositivo.max, ultimoMs: ahora - 60_000 };
    assert.equal(esperaTotalSeg({ usuarioDispositivo: libre, dispositivo: lleno, ip: libre }, ahora), LIMITES.dispositivo.enfriaSeg - 60);
    assert.equal(superaBloqueoDuro(LIMITES.duro.max - 1), false);
    assert.equal(superaBloqueoDuro(LIMITES.duro.max), true);
});

test("código de equipo: formato legible, sin caracteres ambiguos y el hash ignora guiones y mayúsculas", () => {
    for (let i = 0; i < 50; i++) {
        const c = generarCodigo();
        assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    assert.equal(normalizarCodigo(" ab2c-d3ef "), "AB2CD3EF");
    assert.equal(hashCodigo("ab2c-d3ef"), hashCodigo("AB2CD3EF"));
    assert.notEqual(hashCodigo("AB2CD3EF"), hashCodigo("AB2CD3EG"));
});

test("una sesión de PIN no autoriza por sí misma aunque el rol tenga pos.autorizar", () => {
    assert.equal(puedeAutorizarUsuario({ permisos: ["pos.autorizar"] }), true);
    assert.equal(puedeAutorizarUsuario({ permisos: ["pos.autorizar"], pin: true }), false);
    assert.equal(puedeAutorizarUsuario({ is_admin: true, pin: true }), false);
    assert.equal(puedeAutorizarUsuario({ is_admin: true }), true);
});
