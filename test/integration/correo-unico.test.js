import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// AUD-003: el correo identifica a la persona en TODA la plataforma. La base lo guarda normalizado (minúsculas, sin espacios al borde)
// y único global; el login busca por ese mismo valor. Ya no hay dos cuentas que el login confunda.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración — correo normalizado y único global (AUD-003)", { skip: SKIP }, () => {
    const A = 9611;
    const B = 9612;
    const MAIL = "ana@correo-unico.test";
    const CLAVE = "ClaveDePrueba123";
    let server, base, pool, tokA, tokB;

    const req = async (method, path, { token, body } = {}) => {
        const res = await fetch(base + path, {
            method,
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
            /* vacío */
        }
        return { status: res.status, json, texto };
    };
    const insertar = (empresa, codigo, email) =>
        pool.query(
            "INSERT INTO usuarios (nombre,codigo_ingreso,email,empresa_id) VALUES ('Prueba',$1,$2,$3) RETURNING id",
            [codigo, email, empresa],
        );
    const limpiar = async () => {
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query(
            "INSERT INTO empresas (id,nombre) VALUES ($1,'Correo A'),($2,'Correo B')",
            [A, B],
        );
        const admin = async (empresa, codigo) => {
            const id = (
                await pool.query(
                    "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm',$1,true,true,$2) RETURNING id",
                    [codigo, empresa],
                )
            ).rows[0].id;
            return signToken({ id, empresa_id: empresa, is_admin: true, is_owner: true, tv: 0 });
        };
        tokA = await admin(A, "CU-a");
        tokB = await admin(B, "CU-b");
    });

    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("la base rechaza un correo sin normalizar (mayúsculas, espacios al borde, vacío), venga de donde venga", async () => {
        for (const [i, malo] of [
            "Ana@Correo-Unico.test",
            " ana@correo-unico.test",
            "ana@correo-unico.test ",
            "",
        ].entries()) {
            await assert.rejects(
                insertar(A, `CU-malo${i}`, malo),
                (e) => e.code === "23514",
                `«${malo}» debió rechazarse`,
            );
        }
    });

    it("el mismo correo no puede estar en dos empresas, ni exacto ni cambiando mayúsculas por la API", async () => {
        const alta = await req("POST", `/api/usuarios/${A}`, {
            token: tokA,
            body: {
                nombre: "Ana",
                codigo_ingreso: "CU-ana",
                email: " Ana@Correo-Unico.TEST ",
                password: CLAVE,
            },
        });
        assert.equal(alta.status, 201, alta.texto);
        assert.equal(alta.json.data.email, MAIL, "se guarda normalizado");

        await assert.rejects(insertar(B, "CU-exacto", MAIL), (e) => e.code === "23505");

        const otra = await req("POST", `/api/usuarios/${B}`, {
            token: tokB,
            body: {
                nombre: "Otra Ana",
                codigo_ingreso: "CU-otra",
                email: "ANA@correo-unico.TEST",
                password: CLAVE,
            },
        });
        assert.equal(otra.status, 409, otra.texto);
        const filas = await pool.query(
            "SELECT count(*)::int n FROM usuarios WHERE empresa_id = $1 AND email IS NOT NULL",
            [B],
        );
        assert.equal(filas.rows[0].n, 0, "la segunda cuenta no se creó");
    });

    it("cambiar el correo de otro usuario a uno ya usado (con otra capitalización) también es 409", async () => {
        const mio = await req("POST", `/api/usuarios/${B}`, {
            token: tokB,
            body: {
                nombre: "Beto",
                codigo_ingreso: "CU-beto",
                email: "beto@correo-unico.test",
                password: CLAVE,
            },
        });
        assert.equal(mio.status, 201, mio.texto);
        const cambio = await req("PUT", `/api/usuarios/${B}/${mio.json.data.id}`, {
            token: tokB,
            body: { nombre: "Beto", codigo_ingreso: "CU-beto", email: "ANA@CORREO-UNICO.TEST" },
        });
        assert.equal(cambio.status, 409, cambio.texto);
    });

    it("el login encuentra a la persona escriba como escriba el correo, y siempre es la misma cuenta", async () => {
        const esperado = (await pool.query("SELECT id FROM usuarios WHERE email = $1", [MAIL]))
            .rows[0].id;
        for (const escrito of [MAIL, "ANA@CORREO-UNICO.TEST", "  Ana@Correo-Unico.test  "]) {
            const r = await req("POST", "/api/auth/login", {
                body: { email: escrito, password: CLAVE },
            });
            assert.equal(r.status, 200, `${escrito}: ${r.texto}`);
            assert.equal(r.json.data.user.id, esperado);
            assert.equal(r.json.data.user.empresa_id, A);
        }
    });

    it("el repositorio normaliza por sí mismo (scripts y código futuro no pasan por el esquema de la ruta)", async () => {
        const { default: UsuarioRepository } =
            await import("../../src/modules/usuarios/usuario.repository.js");
        const repo = new UsuarioRepository();
        const esperado = (await pool.query("SELECT id FROM usuarios WHERE email = $1", [MAIL]))
            .rows[0].id;
        assert.equal((await repo.findByEmail("  ANA@Correo-Unico.TEST ")).id, esperado);
        assert.equal(await repo.findByEmail("nadie@correo-unico.test"), undefined);
    });
});
