import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AuthController from "../src/modules/auth/auth.controller.js";
import { AUTH_COOKIE } from "../src/utils/authCookie.js";

// `setup` solo funciona con la base de usuarios vacía, así que se prueba el controlador con un servicio simulado.
const JWT = "eyJ.fake.jwt-de-prueba";
const servicio = {
    setup: async () => ({ token: JWT, user: { id: 1, nombre: "Dueño", is_owner: true } }),
    login: async () => ({ token: JWT, user: { id: 1, nombre: "Dueño" }, permisos: ["x"] }),
};
const respuesta = () => {
    const r = { cookies: [], body: null };
    r.cookie = (nombre, valor, opciones) => (r.cookies.push({ nombre, valor, opciones }), r);
    r.json = (b) => ((r.body = b), r);
    r.status = (c) => ((r.statusCode = c), r);
    return r;
};
const llamar = async (handler, req) => {
    const res = respuesta();
    await handler(req, res, (e) => {
        throw e;
    });
    return res;
};

describe("controlador de autenticación: el JWT solo viaja en la cookie httpOnly", () => {
    const controlador = new AuthController(servicio);

    for (const [nombre, handler, req] of [
        ["login", controlador.login, { body: { email: "a@b.mx", password: "x" } }],
        ["setup", controlador.setup, { body: {}, headers: {} }],
    ]) {
        it(`${nombre}: deja la sesión en la cookie ${AUTH_COOKIE} (httpOnly) y NO devuelve token en el body`, async () => {
            const res = await llamar(handler, req);
            assert.equal(res.cookies.length, 1);
            assert.equal(res.cookies[0].nombre, AUTH_COOKIE);
            assert.equal(res.cookies[0].valor, JWT);
            assert.equal(res.cookies[0].opciones.httpOnly, true);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.token, undefined, "el body no debe incluir el token");
            assert.ok(!JSON.stringify(res.body).includes(JWT), "el JWT no debe aparecer en ninguna parte del body");
            assert.ok(res.body.data.user, "el resto de la respuesta se conserva");
        });
    }

    it("login conserva los demás campos del servicio (permisos, etc.)", async () => {
        const res = await llamar(controlador.login, { body: { email: "a@b.mx", password: "x" } });
        assert.deepEqual(res.body.data.permisos, ["x"]);
    });
});
