import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

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

const cabecera = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());

test("jwt: se firma siempre con HS256 (también al re-firmar una sesión que ya trae exp)", () => {
    assert.equal(cabecera(signToken({ id: 1 })).alg, "HS256");
    assert.equal(
        cabecera(signToken({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 })).alg,
        "HS256",
    );
});

test("jwt: solo se acepta HS256; otra variante HMAC con la MISMA clave se rechaza", () => {
    for (const algorithm of ["HS384", "HS512"]) {
        const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { algorithm, expiresIn: "1h" });
        assert.throws(
            () => verifyToken(token),
            /invalid algorithm/i,
            `${algorithm} debió rechazarse`,
        );
    }
    assert.equal(
        verifyToken(jwt.sign({ id: 1 }, process.env.JWT_SECRET, { algorithm: "HS256" })).id,
        1,
    );
});
