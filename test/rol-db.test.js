import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluarRolDeAplicacion, verificarRolDeAplicacion } from "../src/config/rolDb.js";

const minimo = { usuario: "gh_app", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, tablas_propias: 0 };
const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };

describe("guardia del rol de la base: decisión", () => {
    it("un rol de privilegios mínimos está bien en cualquier entorno", () => {
        for (const env of [PROD, DEV, {}, { NODE_ENV: "staging" }]) assert.deepEqual(evaluarRolDeAplicacion(minimo, env), { nivel: "ok", motivos: [] });
    });

    it("cada privilegio de más es un motivo por sí solo", () => {
        const casos = [["rolsuper", /SUPERUSUARIO/], ["rolbypassrls", /BYPASSRLS/], ["rolcreaterole", /CREATEROLE/], ["rolcreatedb", /CREATEDB/]];
        for (const [campo, patron] of casos) {
            const r = evaluarRolDeAplicacion({ ...minimo, [campo]: true }, PROD);
            assert.equal(r.nivel, "error", campo);
            assert.match(r.motivos.join(" "), patron);
        }
        const dueno = evaluarRolDeAplicacion({ ...minimo, tablas_propias: 43 }, PROD);
        assert.equal(dueno.nivel, "error");
        assert.match(dueno.motivos[0], /dueño de 43 tablas/);
    });

    it("en producción es error (cualquier NODE_ENV que no sea development/test, incluido ausente o «staging»)", () => {
        for (const NODE_ENV of ["production", "staging", undefined, ""]) {
            assert.equal(evaluarRolDeAplicacion({ ...minimo, rolsuper: true }, { NODE_ENV }).nivel, "error", `NODE_ENV=${NODE_ENV}`);
        }
    });

    it("en desarrollo y pruebas solo avisa", () => {
        for (const NODE_ENV of ["development", "test"]) assert.equal(evaluarRolDeAplicacion({ ...minimo, rolsuper: true }, { NODE_ENV }).nivel, "aviso");
    });

    it("PERMITIR_DB_SUPERUSUARIO=1 baja el error de producción a aviso; otros valores no", () => {
        assert.equal(evaluarRolDeAplicacion({ ...minimo, rolsuper: true }, { ...PROD, PERMITIR_DB_SUPERUSUARIO: "1" }).nivel, "aviso");
        for (const v of ["0", "true", "si", ""]) assert.equal(evaluarRolDeAplicacion({ ...minimo, rolsuper: true }, { ...PROD, PERMITIR_DB_SUPERUSUARIO: v }).nivel, "error", v);
    });
});

describe("guardia del rol de la base: arranque", () => {
    const espiar = () => {
        const r = { errores: [], avisos: [], salidas: [] };
        return { r, log: { error: (m) => r.errores.push(m), warn: (m) => r.avisos.push(m) }, salir: (c) => r.salidas.push(c) };
    };
    const baseCon = (fila) => ({ query: async () => ({ rows: fila ? [fila] : [] }) });

    it("rol mínimo: silencio, no sale", async () => {
        const { r, log, salir } = espiar();
        const res = await verificarRolDeAplicacion(baseCon(minimo), { env: PROD, log, salir });
        assert.equal(res.nivel, "ok");
        assert.deepEqual(r, { errores: [], avisos: [], salidas: [] });
    });

    it("superusuario en producción: error claro, nombra el rol y sale con código 1", async () => {
        const { r, log, salir } = espiar();
        await verificarRolDeAplicacion(baseCon({ ...minimo, usuario: "postgres", rolsuper: true }), { env: PROD, log, salir });
        assert.deepEqual(r.salidas, [1]);
        assert.match(r.errores.join("\n"), /«postgres» es SUPERUSUARIO/);
        assert.match(r.errores.join("\n"), /PERMITIR_DB_SUPERUSUARIO=1/);
    });

    it("superusuario en desarrollo: aviso, no sale", async () => {
        const { r, log, salir } = espiar();
        await verificarRolDeAplicacion(baseCon({ ...minimo, usuario: "postgres", rolsuper: true }), { env: DEV, log, salir });
        assert.deepEqual(r.salidas, []);
        assert.match(r.avisos.join("\n"), /AVISO \(desarrollo\).*SUPERUSUARIO/);
    });

    it("con la bandera de escape en producción: avisa fuerte y arranca", async () => {
        const { r, log, salir } = espiar();
        await verificarRolDeAplicacion(baseCon({ ...minimo, rolsuper: true }), { env: { ...PROD, PERMITIR_DB_SUPERUSUARIO: "1" }, log, salir });
        assert.deepEqual(r.salidas, []);
        assert.match(r.avisos.join("\n"), /PERMITIR_DB_SUPERUSUARIO=1/);
    });

    it("si la base no responde NO aborta el arranque (una caída transitoria no es un hallazgo de seguridad)", async () => {
        const { r, log, salir } = espiar();
        const caida = { query: async () => { throw new Error("connect ECONNREFUSED"); } };
        const res = await verificarRolDeAplicacion(caida, { env: PROD, log, salir });
        assert.equal(res.nivel, "desconocido");
        assert.deepEqual(r.salidas, []);
        assert.match(r.avisos.join("\n"), /No se pudo comprobar el rol.*ECONNREFUSED/);
    });
});
