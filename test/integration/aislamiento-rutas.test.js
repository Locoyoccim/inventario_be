import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import {
    inspeccionar,
    validarClasificacion,
    clasificar,
    resumen,
} from "../helpers/catalogoRutas.js";
import {
    descubrirAlcance,
    huellaEmpresas,
    diferencias,
    limpiarEmpresas,
} from "../helpers/alcance.js";

// Fase 5 · prueba A — catálogo de rutas del router REAL.
//   1. Las 172 rutas (+ los 2 endpoints de salud) están clasificadas; una ruta nueva sin clasificar o un router desconocido falla.
//   2. Las rutas con :empresa_id: token de la empresa B contra la URL de la empresa A → 403, sin devolver NI tocar datos de A.
//   3. Las demás categorías (plataforma, empresa propia, receta propia, sin token) se comportan como declara su motivo.
// Requiere TEST_DATABASE_URL (BD de pruebas migrada).

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

const MARCA = "MARCA-A"; // aparece en TODO dato de la empresa A: si sale en una respuesta a otra empresa, es una fuga

describe("Aislamiento multiempresa — catálogo de rutas (prueba A)", { skip: SKIP }, () => {
    const A = 9851;
    const B = 9852;
    let server, base, pool, signToken, alcance;
    let catalogo, recetaA, tokAdminA, tokAdminB, tokPlataformaB;

    const req = async (metodo, ruta, { token, body } = {}) => {
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
        return { status: res.status, texto, json };
    };

    /** URL concreta de una ruta del catálogo: la empresa A en :empresa_id y "1" en cualquier otro parámetro. */
    const urlDe = (ruta, empresaId = A) =>
        ruta.replace(":empresa_id", String(empresaId)).replace(/:[a-zA-Z_]+/g, "1");
    const mkUsuario = async (empresa, codigo, { plataforma = false } = {}) => {
        const id = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,is_platform_admin,empresa_id) VALUES ($1,$1,$2,true,true,$3,$4) RETURNING id",
                [codigo, `${codigo.toLowerCase()}@aislamiento.test`, plataforma, empresa],
            )
        ).rows[0].id;
        return signToken({
            id,
            empresa_id: empresa,
            is_admin: true,
            is_owner: true,
            is_platform_admin: plataforma,
            tv: 0,
        });
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        const { default: routes } = await import("../../src/routes/index.js");
        const { default: authRoutes } = await import("../../src/routes/auth.routes.js");
        const { default: agenteRoutes } = await import("../../src/routes/agente.routes.js");
        const { posController } = await import("../../src/container.js");
        ({ server, base } = await iniciarServidor(appMod.default));

        catalogo = inspeccionar({
            app: appMod.default,
            montajes: [
                {
                    nombre: "api",
                    prefijo: "/api",
                    router: routes,
                    precedidoPor: ["requireAuth", "requireActiveUser", "requirePasswordCurrent"],
                },
                { nombre: "auth", prefijo: "/api/auth", router: authRoutes },
                // Todo lo que se registra después de router.use(requireAgente) exige el token del agente; /emparejar va antes, a propósito.
                {
                    nombre: "agente",
                    prefijo: "/api/agente",
                    router: agenteRoutes,
                    capasUso: [{ nombre: "requireAgente", fn: posController.requireAgente }],
                },
            ],
        });

        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, [A, B], alcance);
        await pool.query(
            "INSERT INTO empresas (id,nombre) VALUES ($1,$3), ($2,'Empresa B aislamiento')",
            [A, B, `${MARCA} empresa`],
        );
        await pool.query(
            "INSERT INTO categorias (empresa_id, nombre) SELECT unnest($1::int[]), $2",
            [[A, B], `${MARCA} cat`],
        );
        tokAdminA = await mkUsuario(A, `${MARCA}-admin`);
        tokAdminB = await mkUsuario(B, "B-admin");
        tokPlataformaB = await mkUsuario(B, "B-plataforma", { plataforma: true });

        // Datos de A, creados por su propio Admin a través de la API.
        const proveedor = (
            await req("POST", `/api/proveedores/${A}`, {
                token: tokAdminA,
                body: { nombre: `${MARCA} proveedor` },
            })
        ).json.data;
        const producto = (
            await req("POST", `/api/productos/${A}`, {
                token: tokAdminA,
                body: {
                    producto: `${MARCA} producto`,
                    unidad_medida: "pz",
                    proveedor_id: proveedor.id,
                    categoria: `${MARCA} cat`,
                    cantidad_presentacion: 1,
                    costo_presentacion: 10,
                    stock_actual: 10,
                    stock_minimo: 1,
                },
            })
        ).json.data;
        recetaA = (
            await req("POST", `/api/recetas/${A}`, {
                token: tokAdminA,
                body: {
                    nombre: `${MARCA} receta`,
                    categoria: `${MARCA} cat`,
                    precio_venta: 50,
                    ingredientes: [{ producto_id: producto.id, cantidad: 1 }],
                },
            })
        ).json.data.id;
        assert.ok(recetaA, "fixture: la receta de A debe existir");
    });

    after(async () => {
        await limpiarEmpresas(pool, [A, B], alcance);
        await pool.end();
        server.close();
    });

    it("todas las rutas del router real están clasificadas, con sus guardias puestas (172 + salud)", (t) => {
        const problemas = [...catalogo.problemas, ...validarClasificacion(catalogo)];
        assert.deepEqual(problemas, [], `\n${problemas.join("\n")}`);
        const cuenta = resumen(catalogo.rutas);
        t.diagnostic(`rutas: ${catalogo.rutas.length} · ${JSON.stringify(cuenta)}`);
        assert.equal(cuenta["SIN CLASIFICAR"], undefined);
        assert.equal(
            catalogo.rutas.filter((r) => r.router !== "app").length,
            172,
            "el catálogo debía cubrir las 172 rutas conocidas; si cambió a propósito, actualiza este número",
        );
        assert.equal(catalogo.rutas.filter((r) => r.router === "app").length, 2);
    });

    it("control positivo: la empresa A SÍ ve sus datos (el detector de fugas no es ciego)", async () => {
        const r = await req("GET", `/api/productos/${A}`, { token: tokAdminA });
        assert.equal(r.status, 200);
        assert.ok(r.texto.includes(MARCA), "la respuesta a A debe contener su marcador");
        const rec = await req("GET", `/api/recetas/${recetaA}/detalle`, { token: tokAdminA });
        assert.equal(rec.status, 200, "la receta de A, vista por A, responde");
    });

    for (const [nombre, tok] of [
        ["Admin de B", () => tokAdminB],
        ["usuario maestro de plataforma de B", () => tokPlataformaB],
    ]) {
        it(`rutas tenant: ${nombre} contra la URL de A → 403 en cada una, sin devolver ni modificar datos de A`, async (t) => {
            const tenant = catalogo.rutas.filter((r) => clasificar(r)?.categoria === "tenant");
            const antes = await huellaEmpresas(pool, [A], alcance);
            const empresasAntes = (await pool.query("SELECT count(*)::int n FROM empresas")).rows[0]
                .n;
            const fallos = [];
            for (const r of tenant) {
                const res = await req(r.metodo, urlDe(r.ruta), {
                    token: tok(),
                    body: r.metodo === "GET" ? undefined : {},
                });
                if (res.status !== 403)
                    fallos.push(`${r.metodo} ${r.ruta} → ${res.status} (esperado 403)`);
                if (res.texto.includes(MARCA))
                    fallos.push(`${r.metodo} ${r.ruta} devolvió datos de A`);
            }
            t.diagnostic(`${tenant.length} rutas tenant probadas`);
            assert.ok(tenant.length >= 149, `se esperaban ≥149 rutas tenant, hay ${tenant.length}`);
            assert.deepEqual(fallos, [], `\n${fallos.join("\n")}`);
            assert.deepEqual(
                diferencias(antes, await huellaEmpresas(pool, [A], alcance)),
                {},
                "los datos de A cambiaron",
            );
            assert.equal(
                (await pool.query("SELECT count(*)::int n FROM empresas")).rows[0].n,
                empresasAntes,
            );
        });
    }

    it("sin token, todas las rutas del router de la API responden 401 (la cadena de autenticación está delante)", async () => {
        const api = catalogo.rutas.filter((r) => r.router === "api");
        const fallos = [];
        for (const r of api) {
            const res = await req(r.metodo, urlDe(r.ruta), {
                body: r.metodo === "GET" ? undefined : {},
            });
            if (res.status !== 401)
                fallos.push(`${r.metodo} ${r.ruta} → ${res.status} (esperado 401)`);
        }
        assert.deepEqual(fallos, [], `\n${fallos.join("\n")}`);
    });

    it("plataforma: un Admin de empresa (aunque sea dueño) no puede usarla → 403 y nada cambia", async () => {
        const rutas = catalogo.rutas.filter((r) => clasificar(r)?.categoria === "plataforma");
        assert.equal(rutas.length, 5);
        const antes = await huellaEmpresas(pool, [A], alcance);
        const empresasAntes = (await pool.query("SELECT count(*)::int n FROM empresas")).rows[0].n;
        for (const tok of [tokAdminA, tokAdminB]) {
            for (const r of rutas) {
                const res = await req(r.metodo, urlDe(r.ruta), {
                    token: tok,
                    body: r.metodo === "GET" ? undefined : {},
                });
                assert.equal(res.status, 403, `${r.metodo} ${r.ruta}`);
                assert.ok(!res.texto.includes(MARCA));
            }
        }
        assert.deepEqual(diferencias(antes, await huellaEmpresas(pool, [A], alcance)), {});
        assert.equal(
            (await pool.query("SELECT count(*)::int n FROM empresas")).rows[0].n,
            empresasAntes,
        );
    });

    it("empresa propia: la configuración de A no se lee ni se cambia desde B", async () => {
        const antes = await huellaEmpresas(pool, [A], alcance);
        const lee = await req("GET", `/api/empresas/${A}/configuracion`, { token: tokAdminB });
        const cambia = await req("PUT", `/api/empresas/${A}/configuracion`, {
            token: tokAdminB,
            body: { usa_pantalla_cocina: true },
        });
        assert.equal(lee.status, 403);
        assert.equal(cambia.status, 403);
        assert.ok(!lee.texto.includes(MARCA) && !cambia.texto.includes(MARCA));
        assert.deepEqual(diferencias(antes, await huellaEmpresas(pool, [A], alcance)), {});
        assert.equal(
            (await req("GET", `/api/empresas/${A}/configuracion`, { token: tokAdminA })).status,
            200,
            "control: A sí la lee",
        );
    });

    it("receta propia: el detalle de una receta de A no se ve desde B → 403", async () => {
        const r = await req("GET", `/api/recetas/${recetaA}/detalle`, { token: tokAdminB });
        assert.equal(r.status, 403);
        assert.ok(!r.texto.includes(MARCA));
        const inexistente = await req("GET", "/api/recetas/2147483000/detalle", {
            token: tokAdminB,
        });
        assert.equal(
            inexistente.status,
            404,
            "una receta que no existe responde 404, distinto del 403 de una ajena",
        );
    });

    it("solo sesión: /auth/me devuelve únicamente al propio usuario", async () => {
        const r = await req("GET", "/api/auth/me", { token: tokAdminB });
        assert.equal(r.status, 200);
        assert.ok(!r.texto.includes(MARCA));
        assert.equal(Number(r.json.data.empresa_id), B);
    });

    it("salud: /health y /health/ready no devuelven datos de ninguna empresa", async () => {
        for (const ruta of ["/health", "/health/ready"]) {
            const r = await req("GET", ruta);
            assert.equal(r.status, 200, ruta);
            assert.ok(!r.texto.includes(MARCA));
        }
    });
});
