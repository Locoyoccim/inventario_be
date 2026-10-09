import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import { descubrirAlcance, limpiarEmpresas } from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";

// Acceso compartido entre empresas: el maestro de plataforma da a un Owner/Admin acceso a OTRA empresa; la sesión lleva UNA empresa
// activa (la base o un acceso vigente) y los datos siguen viajando por empresa. Aquí se fija el modelo de seguridad:
// quién concede/retira, qué rol vale en cada empresa, y que sin acceso vigente no hay sesión (401), nunca datos de otra empresa.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Acceso multiempresa — concesión, empresa activa y aislamiento", { skip: SKIP }, () => {
    const [A, B, C] = [9911, 9912, 9913];
    const IDS = [A, B, C];
    const sufijo = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    let server,
        base,
        pool,
        alcance,
        signToken,
        candado,
        invalidarUsuarioActivo,
        invalidarDispositivo;
    let ownerA, ownerB, adminB, operativoA, maestro;

    const email = (p) => `${p}-${sufijo}@acceso.test`;
    const mkUsuario = async (
        empresa,
        codigo,
        { owner = false, admin = owner, plataforma = false } = {},
    ) =>
        (
            await pool.query(
                `INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,is_platform_admin,empresa_id)
                 VALUES ($1,$1,$2,$3,$4,$5,$6) RETURNING id`,
                [`acc-${codigo}`, email(codigo), admin, owner, plataforma, empresa],
            )
        ).rows[0].id;
    const tok = (id, empresa, extra = {}) =>
        signToken({ id, empresa_id: empresa, tv: 0, ...extra });
    const http = async (metodo, ruta, { token, body } = {}) => {
        const res = await fetch(base + ruta, {
            method: metodo,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* sin cuerpo JSON */
        }
        return { status: res.status, texto, json, cookies: res.headers.getSetCookie() };
    };
    const conceder = (usuario, destino, body = {}, token = tMaestro()) =>
        http("PUT", `/api/platform/usuarios/${usuario}/empresas/${destino}`, { token, body });
    const retirar = (usuario, destino, token = tMaestro()) =>
        http("DELETE", `/api/platform/usuarios/${usuario}/empresas/${destino}`, { token });
    const tMaestro = () => tok(maestro, C);
    const acceso = async (usuario, empresa) =>
        (
            await pool.query(
                "SELECT * FROM usuario_empresas WHERE usuario_id = $1 AND empresa_id = $2",
                [usuario, empresa],
            )
        ).rows[0];

    before(async () => {
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ invalidarUsuarioActivo, invalidarDispositivo } =
            await import("../../src/middlewares/activeUser.js"));
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        for (const id of IDS)
            await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, $2)", [
                id,
                `Acceso ${id}`,
            ]);
        ownerA = await mkUsuario(A, `ownA${A}`, { owner: true });
        ownerB = await mkUsuario(B, `ownB${B}`, { owner: true });
        adminB = await mkUsuario(B, `admB${B}`, { admin: true });
        operativoA = await mkUsuario(A, `opeA${A}`, { admin: false });
        maestro = await mkUsuario(C, `mae${C}`, { owner: true, plataforma: true });
    });

    after(async () => {
        await limpiarEmpresas(pool, IDS, alcance);
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    describe("quién concede y a quién", () => {
        it("solo el maestro concede: ni el Owner de la empresa ni un Admin pueden", async () => {
            for (const t of [tok(ownerA, A), tok(ownerB, B), tok(adminB, B)]) {
                const r = await conceder(ownerA, B, {}, t);
                assert.equal(r.status, 403, r.texto);
            }
            assert.equal(await acceso(ownerA, B), undefined, "no se creó ningún acceso");
        });

        it("el maestro concede a un Owner/Admin; el acceso queda con quién lo otorgó y como Admin por defecto", async () => {
            const r = await conceder(ownerA, B);
            assert.equal(r.status, 200, r.texto);
            const fila = await acceso(ownerA, B);
            assert.equal(fila.activo, true);
            assert.equal(fila.is_admin, true);
            assert.equal(Number(fila.otorgado_por), maestro);
            await retirar(ownerA, B);
        });

        it("rechaza: a un Operativo, la empresa base, una empresa inexistente o desactivada, un usuario inactivo o un rol inexistente", async () => {
            assert.equal((await conceder(operativoA, B)).status, 400, "Operativo");
            assert.equal((await conceder(ownerA, A)).status, 400, "su empresa base");
            assert.equal((await conceder(ownerA, 8999999)).status, 404, "empresa inexistente");
            assert.equal(
                (await conceder(ownerA, B, { role_id: 987654 })).status,
                400,
                "rol inexistente",
            );
            await pool.query("UPDATE empresas SET activo = false WHERE id = $1", [B]);
            try {
                assert.equal((await conceder(ownerA, B)).status, 400, "empresa desactivada");
            } finally {
                await pool.query("UPDATE empresas SET activo = true WHERE id = $1", [B]);
            }
            await pool.query("UPDATE usuarios SET activo = false WHERE id = $1", [adminB]);
            try {
                assert.equal((await conceder(adminB, A)).status, 400, "usuario inactivo");
            } finally {
                await pool.query("UPDATE usuarios SET activo = true WHERE id = $1", [adminB]);
            }
            assert.equal((await conceder(999999999, B)).status, 404, "usuario inexistente");
        });

        it("el maestro puede asignarse empresas a sí mismo (decisión del propietario)", async () => {
            const r = await conceder(maestro, A);
            assert.equal(r.status, 200, r.texto);
            const lee = await http("GET", `/api/productos/${A}`, { token: tok(maestro, A) });
            assert.equal(lee.status, 200, "con su acceso opera en A");
            const otra = await http("GET", `/api/productos/${B}`, { token: tok(maestro, A) });
            assert.equal(otra.status, 403, "con la empresa A activa no ve B");
            await retirar(maestro, A);
        });

        it("la base de datos también rechaza un acceso a la empresa base (trigger)", async () => {
            await assert.rejects(
                pool.query(
                    "INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2)",
                    [ownerA, A],
                ),
                (e) => e.code === "23514",
            );
        });

        it("el listado del maestro trae solo Owner/Admin activos y sus accesos", async () => {
            await conceder(ownerA, B);
            const r = await http("GET", `/api/platform/accesos?empresa_id=${A}`, {
                token: tMaestro(),
            });
            assert.equal(r.status, 200, r.texto);
            const ids = r.json.data.map((u) => u.id);
            assert.ok(ids.includes(ownerA));
            assert.ok(!ids.includes(operativoA), "un Operativo no es candidato");
            const o = r.json.data.find((u) => u.id === ownerA);
            assert.deepEqual(
                o.accesos.map((a) => [a.empresa_id, a.activo]),
                [[B, true]],
            );
            assert.equal(
                (await http("GET", "/api/platform/accesos", { token: tok(ownerA, A) })).status,
                403,
            );
            await retirar(ownerA, B);
        });
    });

    describe("empresa activa: la sesión lleva UNA empresa", () => {
        before(async () => {
            assert.equal((await conceder(ownerA, B, { is_admin: true })).status, 200);
        });
        after(async () => {
            await retirar(ownerA, B);
        });

        it("con acceso vigente la sesión de la empresa destino funciona; sin acceso a otra empresa → 401", async () => {
            const enB = await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) });
            assert.equal(enB.status, 200, enB.texto);
            const enC = await http("GET", `/api/productos/${C}`, { token: tok(ownerA, C) });
            assert.equal(enC.status, 401, "empresa sin acceso: ni sesión");
        });

        it("los datos van por empresa: con B activa, la URL de A (su propia base) o la de C se rechazan (403)", async () => {
            for (const e of [A, C]) {
                const r = await http("GET", `/api/productos/${e}`, { token: tok(ownerA, B) });
                assert.equal(r.status, 403, `empresa ${e}: ${r.texto.slice(0, 100)}`);
            }
        });

        it("POST /auth/empresa-activa re-firma la sesión con esa empresa, conserva la caducidad y devuelve el perfil de ESA empresa", async () => {
            const original = tok(ownerA, A);
            const r = await http("POST", "/api/auth/empresa-activa", {
                token: original,
                body: { empresa_id: B },
            });
            assert.equal(r.status, 200, r.texto);
            assert.equal(r.json.data.empresa_id, B);
            assert.equal(r.json.data.empresa_nombre, `Acceso ${B}`);
            assert.equal(r.json.data.is_owner, false, "en una empresa compartida nunca es Owner");
            assert.equal(r.json.data.is_admin, true);
            assert.deepEqual(
                r.json.data.empresas.map((e) => [e.id, e.base]),
                [
                    [A, true],
                    [B, false],
                ],
            );
            const cookie = r.cookies.find((c) => c.startsWith("gh_session="));
            assert.ok(cookie, "se fijó la cookie de sesión");
            assert.ok(
                !r.texto.includes(cookie.split(";")[0].split("=")[1]),
                "el JWT no viaja en el cuerpo",
            );
            const nuevo = cookie.split(";")[0].slice("gh_session=".length);
            const claims = JSON.parse(Buffer.from(nuevo.split(".")[1], "base64url").toString());
            const viejos = JSON.parse(Buffer.from(original.split(".")[1], "base64url").toString());
            assert.equal(claims.empresa_id, B);
            assert.equal(claims.tv, viejos.tv, "misma versión de sesión");
            assert.equal(
                claims.exp,
                viejos.exp,
                "la caducidad no se extiende por cambiar de empresa",
            );
            // y esa sesión nueva ya sirve en B
            assert.equal((await http("GET", `/api/productos/${B}`, { token: nuevo })).status, 200);
        });

        it("rechaza una empresa sin acceso, una sesión de PIN y un token sin sesión", async () => {
            const sinAcceso = await http("POST", "/api/auth/empresa-activa", {
                token: tok(ownerA, A),
                body: { empresa_id: C },
            });
            assert.equal(sinAcceso.status, 403);
            const pin = await http("POST", "/api/auth/empresa-activa", {
                token: tok(operativoA, A, { pin: true, disp: 8999999 }),
                body: { empresa_id: B },
            });
            assert.ok([401, 403].includes(pin.status), `PIN: ${pin.status}`);
            assert.equal(
                (await http("POST", "/api/auth/empresa-activa", { body: { empresa_id: B } }))
                    .status,
                401,
            );
            const invalida = await http("POST", "/api/auth/empresa-activa", {
                token: tok(ownerA, A),
                body: { empresa_id: "x" },
            });
            assert.equal(invalida.status, 400);
        });

        it("/auth/me con la empresa compartida activa devuelve esa empresa y las opciones", async () => {
            const r = await http("GET", "/api/auth/me", { token: tok(ownerA, B) });
            assert.equal(r.status, 200, r.texto);
            assert.equal(r.json.data.empresa_id, B);
            assert.equal(r.json.data.empresas.length, 2);
        });

        it("quien no tiene accesos no recibe selector (empresas vacío) y /auth/me sigue igual", async () => {
            const r = await http("GET", "/api/auth/me", { token: tok(ownerB, B) });
            assert.equal(r.status, 200);
            assert.deepEqual(r.json.data.empresas, []);
            assert.equal(r.json.data.empresa_nombre, `Acceso ${B}`);
        });

        it("las acciones de su propia cuenta (cerrar todas las sesiones) actúan sobre su fila base aunque la empresa activa sea la compartida", async () => {
            const antes = Number(
                (await pool.query("SELECT token_version FROM usuarios WHERE id = $1", [ownerA]))
                    .rows[0].token_version,
            );
            const r = await http("POST", "/api/auth/logout-all", { token: tok(ownerA, B) });
            assert.equal(r.status, 200, r.texto);
            const despues = Number(
                (await pool.query("SELECT token_version FROM usuarios WHERE id = $1", [ownerA]))
                    .rows[0].token_version,
            );
            assert.equal(despues, antes + 1, "se revocaron las sesiones de la persona");
            // sus sesiones (en A y en B) quedan revocadas; se restablece el estado para los siguientes
            assert.equal(
                (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                401,
            );
            await pool.query("UPDATE usuarios SET token_version = 0 WHERE id = $1", [ownerA]);
            invalidarUsuarioActivo(ownerA);
        });
    });

    describe("PIN y equipos son de la empresa base", () => {
        it("una sesión de PIN (equipo de su empresa base) no sirve en una empresa compartida, aunque la persona tenga ese acceso", async () => {
            // Un Operativo no puede recibir acceso por la API (solo Owner/Admin); se fuerza por SQL para probar la guarda aislada.
            const equipo = (
                await pool.query(
                    "INSERT INTO dispositivos (empresa_id, nombre) VALUES ($1, $2) RETURNING id",
                    [A, `equipo-${sufijo}`],
                )
            ).rows[0].id;
            await pool.query(
                "INSERT INTO usuario_empresas (usuario_id, empresa_id, is_admin) VALUES ($1, $2, false)",
                [operativoA, B],
            );
            invalidarUsuarioActivo(operativoA);
            invalidarDispositivo(equipo); // la caché de equipos es por id y otra prueba pudo dejar «inactivo» ese mismo id
            try {
                const pin = { pin: true, disp: equipo, is_admin: false, is_owner: false };
                const enBase = await http("GET", `/api/productos/${A}`, {
                    token: tok(operativoA, A, pin),
                });
                assert.equal(
                    enBase.status,
                    200,
                    `control: el PIN vale en su empresa base (${enBase.texto})`,
                );
                const enB = await http("GET", `/api/productos/${B}`, {
                    token: tok(operativoA, B, pin),
                });
                assert.equal(enB.status, 401, "el PIN no vale en la empresa compartida");
                const cambia = await http("POST", "/api/auth/empresa-activa", {
                    token: tok(operativoA, A, pin),
                    body: { empresa_id: B },
                });
                assert.ok(
                    [401, 403].includes(cambia.status),
                    `no puede cambiar de empresa: ${cambia.status}`,
                );
            } finally {
                await pool.query("DELETE FROM usuario_empresas WHERE usuario_id = $1", [
                    operativoA,
                ]);
                await pool.query("DELETE FROM dispositivos WHERE id = $1", [equipo]);
                invalidarUsuarioActivo(operativoA);
            }
        });
    });

    describe("el rol vale por empresa", () => {
        it("un acceso como Operativo no puede hacer lo de Admin en esa empresa, aunque en su base sea Owner", async () => {
            assert.equal((await conceder(ownerA, B, { is_admin: false })).status, 200);
            try {
                const crea = await http("POST", `/api/usuarios/${B}`, {
                    token: tok(ownerA, B),
                    body: { nombre: "No debe crearse", codigo_ingreso: `no-${sufijo}` },
                });
                assert.equal(crea.status, 403, crea.texto);
                // en su base sigue siendo Owner
                const base = await http("POST", `/api/usuarios/${A}`, {
                    token: tok(ownerA, A),
                    body: { nombre: "Sí", codigo_ingreso: `si-${sufijo}` },
                });
                assert.equal(base.status, 201, base.texto);
            } finally {
                await retirar(ownerA, B);
            }
        });

        it("un acceso como Admin sí puede, pero nunca es Owner: no retira accesos ajenos", async () => {
            assert.equal((await conceder(ownerA, B, { is_admin: true })).status, 200);
            try {
                const crea = await http("POST", `/api/usuarios/${B}`, {
                    token: tok(ownerA, B),
                    body: { nombre: "Creado por el compartido", codigo_ingreso: `ok-${sufijo}` },
                });
                assert.equal(crea.status, 201, crea.texto);
                const retira = await http("DELETE", `/api/usuarios/${B}/${ownerA}/acceso`, {
                    token: tok(ownerA, B),
                });
                assert.equal(retira.status, 403, "un compartido no es Owner");
            } finally {
                await retirar(ownerA, B);
            }
        });
    });

    describe("quitar el acceso", () => {
        it("el maestro lo retira: la sesión de esa empresa pierde acceso al instante (401), el dato histórico se conserva y la base sigue", async () => {
            await conceder(ownerA, B);
            assert.equal(
                (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                200,
            );
            assert.equal((await retirar(ownerA, B)).status, 200);
            assert.equal(
                (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                401,
            );
            assert.equal((await acceso(ownerA, B)).activo, false, "se desactiva, no se borra");
            assert.equal(
                (await http("GET", `/api/productos/${A}`, { token: tok(ownerA, A) })).status,
                200,
            );
            assert.equal((await retirar(ownerA, B)).status, 404, "ya no tiene acceso vigente");
        });

        it("el Owner de la empresa destino también puede retirarlo; un Admin sin ser Owner, no; nadie se retira a sí mismo", async () => {
            await conceder(ownerA, B);
            const comoAdmin = await http("DELETE", `/api/usuarios/${B}/${ownerA}/acceso`, {
                token: tok(adminB, B),
            });
            assert.equal(comoAdmin.status, 403, "Admin sin ser Owner");
            const aSiMismo = await http("DELETE", `/api/usuarios/${B}/${ownerB}/acceso`, {
                token: tok(ownerB, B),
            });
            assert.equal(aSiMismo.status, 400);
            const comoOwner = await http("DELETE", `/api/usuarios/${B}/${ownerA}/acceso`, {
                token: tok(ownerB, B),
            });
            assert.equal(comoOwner.status, 200, comoOwner.texto);
            assert.equal((await acceso(ownerA, B)).activo, false);
            assert.equal(
                (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                401,
            );
        });

        it("el Owner de A no puede retirar accesos a la empresa B (la guarda por empresa lo corta)", async () => {
            await conceder(ownerA, B);
            try {
                const r = await http("DELETE", `/api/usuarios/${B}/${ownerA}/acceso`, {
                    token: tok(ownerA, A),
                });
                assert.equal(r.status, 403);
                assert.equal((await acceso(ownerA, B)).activo, true);
            } finally {
                await retirar(ownerA, B);
            }
        });

        it("si la empresa destino se desactiva o la persona se desactiva, esa sesión cae; la base de la empresa activa sigue sirviendo", async () => {
            await conceder(ownerA, B);
            try {
                await pool.query("UPDATE empresas SET activo = false WHERE id = $1", [B]);
                invalidarUsuarioActivo(ownerA);
                assert.equal(
                    (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                    401,
                );
                assert.equal(
                    (await http("GET", `/api/productos/${A}`, { token: tok(ownerA, A) })).status,
                    200,
                );
                const cambia = await http("POST", "/api/auth/empresa-activa", {
                    token: tok(ownerA, A),
                    body: { empresa_id: B },
                });
                assert.equal(cambia.status, 403, "no puede cambiar a una empresa desactivada");
            } finally {
                await pool.query("UPDATE empresas SET activo = true WHERE id = $1", [B]);
                invalidarUsuarioActivo(ownerA);
            }
            await pool.query("UPDATE usuarios SET activo = false WHERE id = $1", [ownerA]);
            invalidarUsuarioActivo(ownerA);
            try {
                assert.equal(
                    (await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) })).status,
                    401,
                );
            } finally {
                await pool.query("UPDATE usuarios SET activo = true WHERE id = $1", [ownerA]);
                invalidarUsuarioActivo(ownerA);
                await retirar(ownerA, B);
            }
        });
    });

    describe("visibilidad en la empresa destino", () => {
        it("el Admin de B ve al compartido en Usuarios como «compartido» (sin saber su empresa base) y no puede editarlo", async () => {
            await conceder(ownerA, B);
            try {
                const lista = await http("GET", `/api/usuarios/${B}`, { token: tok(adminB, B) });
                assert.equal(lista.status, 200, lista.texto);
                const c = lista.json.data.find((u) => u.id === ownerA);
                assert.ok(c, "aparece en la lista");
                assert.equal(c.compartido, true);
                assert.ok(
                    !("empresa_base" in c) && !("empresa" in c),
                    "no se expone la empresa base de la persona",
                );
                assert.ok(!lista.texto.includes(`Acceso ${A}`), "ni el nombre de la otra empresa");
                assert.equal(lista.json.data.find((u) => u.id === adminB).compartido, false);
                const edita = await http("PUT", `/api/usuarios/${B}/${ownerA}`, {
                    token: tok(ownerB, B),
                    body: { nombre: "Renombrado", codigo_ingreso: "x" },
                });
                assert.equal(
                    edita.status,
                    404,
                    "un compartido no se edita desde la empresa destino",
                );
                // retirado, deja de aparecer
                await retirar(ownerA, B);
                const despues = await http("GET", `/api/usuarios/${B}`, { token: tok(adminB, B) });
                assert.ok(!despues.json.data.some((u) => u.id === ownerA));
            } finally {
                await retirar(ownerA, B).catch(() => {});
            }
        });
    });
});
