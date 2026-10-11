import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { iniciarServidor } from "../helpers/servidor.js";

// Auditoría · sesiones: la API rechaza (401, sin datos) un token caducado, firmado con otra clave, manipulado o sin firma («alg: none»),
// llegue por Authorization o por la cookie de sesión. Es lo que hace que una sesión robada o vieja deje de servir.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("Sesiones — tokens que la API debe rechazar", { skip: SKIP }, () => {
    const A = 9971;
    let server, base, pool, signToken, carga, RUTAS;

    const llamar = async (ruta, { bearer, cookie } = {}) => {
        const res = await fetch(base + ruta, {
            headers: {
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                ...(cookie ? { Cookie: `gh_session=${cookie}` } : {}),
            },
        });
        const texto = await res.text();
        return { status: res.status, texto };
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Tokens')", [A]);
        // Una persona REAL: así lo único que puede causar el 401 de cada caso es el token, no «usuario inexistente».
        const id = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Tok','TK-adm',true,true,$1) RETURNING id",
                [A],
            )
        ).rows[0].id;
        carga = { id, empresa_id: A, is_admin: true, is_owner: true, tv: 0 };
        // La sesión de la persona y una ruta de datos de su propia empresa.
        RUTAS = ["/api/auth/me", `/api/productos/${A}`];
    });

    async function limpiar() {
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [A]);
    }

    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    const casos = {
        "caducado hace un minuto": () => signToken({ ...carga }, -60),
        "firmado con otra clave": () =>
            jwt.sign(carga, "otra_clave_distinta_de_al_menos_32_caracteres", { expiresIn: "7d" }),
        "sin firma (alg none)": () =>
            `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...carga, exp: 4102444800 })}.`,
        "con la firma recortada": () => signToken({ ...carga }).slice(0, -6),
        "con el cuerpo manipulado y la firma vieja": () => {
            const [h, , s] = signToken({ ...carga }).split(".");
            return `${h}.${b64({ ...carga, manipulado: true })}.${s}`;
        },
        basura: () => "no.es.un.jwt",
    };

    for (const [nombre, fabricar] of Object.entries(casos)) {
        it(`token ${nombre}: 401 por Authorization y por cookie, en la sesión y en datos de empresa, sin devolver nada`, async () => {
            const token = fabricar();
            for (const ruta of RUTAS) {
                for (const via of [{ bearer: token }, { cookie: token }]) {
                    const r = await llamar(ruta, via);
                    assert.equal(
                        r.status,
                        401,
                        `${ruta} (${Object.keys(via)[0]}): ${r.texto.slice(0, 120)}`,
                    );
                    assert.ok(!/"data"/.test(r.texto), "no debe devolver datos");
                }
            }
        });
    }

    it("control: el mismo token vigente y bien firmado SÍ entra por Authorization y por cookie (los 401 de arriba vienen del token)", async () => {
        const bueno = signToken({ ...carga });
        for (const ruta of RUTAS) {
            for (const via of [{ bearer: bueno }, { cookie: bueno }]) {
                const r = await llamar(ruta, via);
                assert.equal(
                    r.status,
                    200,
                    `${ruta} (${Object.keys(via)[0]}): ${r.texto.slice(0, 120)}`,
                );
            }
        }
    });
});
