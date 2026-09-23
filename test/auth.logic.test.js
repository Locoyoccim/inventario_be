import test from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "secreto-de-prueba";
const { requireAdmin } = await import("../src/middlewares/auth.js");

const run = (user) => {
    let err = "no-llamado";
    requireAdmin({ user }, {}, (e) => { err = e; });
    return err;
};

test("permisos: Admin (is_admin) pasa", () => {
    assert.equal(run({ is_admin: true }), undefined);
});
test("permisos: Dueño (is_owner) pasa", () => {
    assert.equal(run({ is_owner: true }), undefined);
});
test("permisos: Operativo (sin flags) es bloqueado", () => {
    const err = run({ is_admin: false, is_owner: false });
    assert.ok(err && err !== "no-llamado", "debe llamar next con un error");
});
test("permisos: sin usuario es bloqueado", () => {
    const err = run(undefined);
    assert.ok(err && err !== "no-llamado");
});
