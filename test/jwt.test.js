import test from "node:test";
import assert from "node:assert/strict";

// Fija el secreto ANTES de importar el módulo (lee JWT_SECRET al evaluarse).
process.env.JWT_SECRET = "secreto-de-prueba";

const { signToken, verifyToken } = await import("../src/utils/jwt.js");

test("jwt: round-trip conserva el payload", () => {
    const token = signToken({ id: 1, empresa_id: 4, is_owner: true });
    const decoded = verifyToken(token);
    assert.equal(decoded.id, 1);
    assert.equal(decoded.empresa_id, 4);
    assert.equal(decoded.is_owner, true);
});

test("jwt: un token manipulado no verifica", () => {
    const token = signToken({ id: 1 });
    assert.throws(() => verifyToken(token + "x"));
});
