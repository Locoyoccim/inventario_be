import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "secreto-de-prueba";

const { signToken } = await import("../src/utils/jwt.js");
const { AUTH_COOKIE, readCookie, expiresToMs, authCookieOptions, clearAuthCookieOptions } = await import(
    "../src/utils/authCookie.js"
);
const { requireAuth } = await import("../src/middlewares/auth.js");

// Ejecuta el middleware y devuelve { error, user }.
function run(req) {
    const request = { method: "GET", headers: {}, ...req };
    let error;
    requireAuth(request, {}, (err) => {
        error = err;
    });
    return { error, user: request.user };
}

test("readCookie: encuentra la cookie entre varias y decodifica", () => {
    assert.equal(readCookie("a=1; gh_session=abc%2E123; b=2", "gh_session"), "abc.123");
    assert.equal(readCookie("gh_session_x=1", "gh_session"), null);
    assert.equal(readCookie(undefined, "gh_session"), null);
    assert.equal(readCookie("gh_session=", "gh_session"), null);
});

test("expiresToMs: soporta d/h/m/s y segundos", () => {
    assert.equal(expiresToMs("7d"), 7 * 86400e3);
    assert.equal(expiresToMs("12h"), 12 * 3600e3);
    assert.equal(expiresToMs("3600"), 3600e3);
    assert.equal(expiresToMs("basura"), 7 * 86400e3);
});

test("authCookieOptions: httpOnly siempre; Secure en producción o con SameSite=None", () => {
    const dev = authCookieOptions({ NODE_ENV: "development" });
    assert.equal(dev.httpOnly, true);
    assert.equal(dev.secure, false);
    assert.equal(dev.sameSite, "lax");
    assert.equal(authCookieOptions({ NODE_ENV: "production" }).secure, true);
    assert.equal(authCookieOptions({ COOKIE_SAMESITE: "None" }).secure, true);
    assert.equal(authCookieOptions({ COOKIE_DOMAIN: ".aroma.mx" }).domain, ".aroma.mx");
    assert.equal("maxAge" in clearAuthCookieOptions({}), false);
});

test("requireAuth: acepta Bearer", () => {
    const token = signToken({ id: 1, empresa_id: 4 });
    const { error, user } = run({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(error, undefined);
    assert.equal(user.empresa_id, 4);
});

test("requireAuth: acepta la cookie en lecturas", () => {
    const token = signToken({ id: 1, empresa_id: 4 });
    const { error, user } = run({ headers: { cookie: `${AUTH_COOKIE}=${token}` } });
    assert.equal(error, undefined);
    assert.equal(user.id, 1);
});

test("requireAuth: con cookie, una escritura sin X-Requested-With da 403 (CSRF)", () => {
    const token = signToken({ id: 1, empresa_id: 4 });
    const { error } = run({ method: "POST", headers: { cookie: `${AUTH_COOKIE}=${token}` } });
    assert.equal(error.statusCode, 403);
});

test("requireAuth: con cookie y X-Requested-With la escritura pasa", () => {
    const token = signToken({ id: 1, empresa_id: 4 });
    const { error } = run({
        method: "POST",
        headers: { cookie: `${AUTH_COOKIE}=${token}`, "x-requested-with": "XMLHttpRequest" },
    });
    assert.equal(error, undefined);
});

test("requireAuth: con Bearer no exige el header anti-CSRF", () => {
    const token = signToken({ id: 1, empresa_id: 4 });
    const { error } = run({ method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(error, undefined);
});

test("requireAuth: sin token o con token inválido da 401", () => {
    assert.equal(run({}).error.statusCode, 401);
    assert.equal(run({ headers: { cookie: `${AUTH_COOKIE}=basura` } }).error.statusCode, 401);
});
