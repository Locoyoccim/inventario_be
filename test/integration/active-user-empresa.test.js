import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import {
    descubrirAlcance,
    huellaEmpresas,
    diferencias,
    limpiarEmpresas,
} from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";
import { EmpresaPrueba } from "../helpers/empresaCompleta.js";

// Fase 5 · endurecimiento de requireActiveUser: la empresa del JWT debe ser la de la fila del usuario en la base.
// Antes, todo el aislamiento descansaba en el claim `empresa_id` del token: un token con el id de un usuario de la empresa A y
// `empresa_id` de la B pasaba empresaGuard en las URL de B y operaba allí. Ahora la sesión se rechaza (401).

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("requireActiveUser — la empresa del token debe ser la del usuario", { skip: SKIP }, () => {
    const IDS = [9891, 9892];
    let server, pool, alcance, A, B, signToken, invalidarUsuarioActivo;
    const MARCA_B = () => B.marca;

    let candado;
    before(async () => {
        // Antes de leer el esquema: otro archivo puede estar ejecutando algo global (ver test/helpers/exclusion.js).
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ invalidarUsuarioActivo } = await import("../../src/middlewares/activeUser.js"));
        let base;
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        A = await new EmpresaPrueba({ id: IDS[0], etiqueta: "A", base, pool, signToken }).iniciar();
        B = await new EmpresaPrueba({ id: IDS[1], etiqueta: "B", base, pool, signToken }).iniciar();
    });

    after(async () => {
        await limpiarEmpresas(pool, IDS, alcance);
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    /** Token con la identidad (id) de un usuario de A pero declarando que es de la empresa `empresa`. */
    const tokenDe = (usuarioId, empresa, extra = {}) =>
        signToken({
            id: usuarioId,
            empresa_id: empresa,
            is_admin: true,
            is_owner: true,
            tv: 0,
            ...extra,
        });

    it("control: el token con la empresa correcta funciona", async () => {
        const r = await A.http("GET", `/api/productos/${A.id}`, {
            token: tokenDe(A.adminId, A.id),
        });
        assert.equal(r.status, 200, r.texto);
        assert.ok(r.texto.includes(A.marca));
    });

    it("un token de un usuario de A que declara la empresa B es rechazado (401) y no lee datos de B", async () => {
        const forjado = tokenDe(A.adminId, B.id);
        const r = await B.http("GET", `/api/productos/${B.id}`, { token: forjado });
        assert.equal(
            r.status,
            401,
            `el token con empresa ajena no debía pasar: ${r.status} ${r.texto.slice(0, 160)}`,
        );
        assert.ok(!r.texto.includes(MARCA_B()), "se devolvieron datos de B a un usuario de A");
    });

    it("tampoco puede escribir en B (la huella de B no cambia) ni con rutas de Admin", async () => {
        const forjado = tokenDe(A.adminId, B.id);
        const antes = await huellaEmpresas(pool, [B.id], alcance);
        for (const [metodo, ruta, body] of [
            ["POST", `/api/proveedores/${B.id}`, { nombre: "intruso" }],
            [
                "POST",
                `/api/usuarios/${B.id}`,
                { nombre: "intruso", codigo_ingreso: "intruso-1", is_admin: true },
            ],
            ["PUT", `/api/empresas/${B.id}/configuracion`, { usa_pantalla_cocina: false }],
            ["POST", `/api/pos/${B.id}/mesas`, { nombre: "intruso" }],
        ]) {
            const r = await B.http(metodo, ruta, { token: forjado, body });
            assert.equal(r.status, 401, `${metodo} ${ruta} → ${r.status}`);
        }
        assert.deepEqual(
            diferencias(antes, await huellaEmpresas(pool, [B.id], alcance)),
            {},
            "un token de A modificó datos de B",
        );
    });

    it("/auth/me y el flujo de avisos (SSE) también lo rechazan", async () => {
        const forjado = tokenDe(A.adminId, B.id);
        assert.equal((await B.http("GET", "/api/auth/me", { token: forjado })).status, 401);
        // El SSE no termina si se acepta: se lee solo el estado y se corta la conexión.
        const control = new AbortController();
        const res = await fetch(`${B.base}/api/pos/${B.id}/eventos`, {
            headers: { Authorization: `Bearer ${forjado}` },
            signal: control.signal,
        });
        const estado = res.status;
        control.abort();
        await res.body?.cancel().catch(() => {});
        assert.equal(estado, 401, "el token forjado no debía abrir el flujo de avisos de B");
    });

    it("la sesión de PIN y el usuario maestro de plataforma están sujetos a la misma comprobación", async () => {
        const mesero = await A.nuevo("usuario");
        const pin = tokenDe(mesero.id, B.id, {
            is_admin: false,
            is_owner: false,
            pin: true,
            disp: 1,
        });
        assert.equal((await B.http("GET", `/api/pos/${B.id}/mapa`, { token: pin })).status, 401);
        const plataforma = tokenDe(A.adminId, B.id, { is_platform_admin: true });
        assert.equal(
            (await B.http("GET", `/api/productos/${B.id}`, { token: plataforma })).status,
            401,
        );
    });

    it("el id de empresa del token se compara como número (cadena o número valen igual) pero no se acepta uno distinto", async () => {
        const comoTexto = tokenDe(A.adminId, String(A.id));
        assert.equal(
            (await A.http("GET", `/api/productos/${A.id}`, { token: comoTexto })).status,
            200,
        );
        const sinEmpresa = signToken({ id: A.adminId, is_admin: true, is_owner: true, tv: 0 });
        assert.equal(
            (await A.http("GET", `/api/productos/${A.id}`, { token: sinEmpresa })).status,
            401,
            "un token sin empresa_id no debe pasar",
        );
    });

    it("si un usuario cambia de empresa en la base, su token viejo deja de servir en cuanto se refresca su estado", async () => {
        const u = await A.nuevo("usuario");
        const viejo = tokenDe(u.id, A.id, { is_admin: false, is_owner: false });
        assert.equal((await A.http("GET", "/api/auth/me", { token: viejo })).status, 200);
        await pool.query("UPDATE usuarios SET empresa_id = $1 WHERE id = $2", [B.id, u.id]);
        try {
            invalidarUsuarioActivo(u.id); // sin esto, la caché de 60 s lo seguiría dando por válido (ver docs/AUTH_STRATEGY.md)
            const r = await A.http("GET", `/api/productos/${A.id}`, { token: viejo });
            assert.equal(
                r.status,
                401,
                `el token de la empresa anterior no debía seguir sirviendo: ${r.status}`,
            );
            assert.ok(!r.texto.includes(A.marca));
        } finally {
            await pool.query("UPDATE usuarios SET empresa_id = $1 WHERE id = $2", [A.id, u.id]);
            invalidarUsuarioActivo(u.id);
        }
    });
});
