import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import {
    clasificar,
    inspeccionar,
    validarClasificacion,
    EXCEPCIONES,
} from "./helpers/catalogoRutas.js";

// Controles NEGATIVOS del catálogo de rutas: con apps de mentira se demuestra que el inspector y el clasificador FALLAN ante lo que
// deben (ruta nueva sin clasificar, router desconocido, guardia perdida...). Sin base de datos.
// La prueba contra la app real está en test/integration/aislamiento-rutas.test.js.

function empresaGuard(_req, _res, next) {
    next();
}
function requireAuth(_req, _res, next) {
    next();
}
function requireActiveUser(_req, _res, next) {
    next();
}
function requirePasswordCurrent(_req, _res, next) {
    next();
}
const ok = (_req, res) => res.json({});

const CADENA = ["requireAuth", "requireActiveUser", "requirePasswordCurrent"];

/** App mínima con la misma forma que src/app.js. `variante` deja romper una pieza cada vez. */
function construir({
    guardia = true,
    ordenCadena = [requireAuth, requireActiveUser, requirePasswordCurrent],
    rutas = (r) => r.get("/cosas/:empresa_id", ok),
    extra,
} = {}) {
    const app = express();
    app.use(express.json());
    app.get("/health", ok);
    const api = Router();
    if (guardia) api.param("empresa_id", empresaGuard);
    rutas(api);
    app.use("/api", ...ordenCadena, api);
    extra?.(app);
    return {
        app,
        api,
        montajes: [{ nombre: "api", prefijo: "/api", router: api, precedidoPor: CADENA }],
    };
}

describe("catálogo de rutas — clasificador", () => {
    it("clasifica solo como «tenant» lo que cuelga de /api/<modulo>/:empresa_id bajo el router de la API", () => {
        assert.equal(
            clasificar({ metodo: "GET", ruta: "/api/productos/:empresa_id", router: "api" })
                ?.categoria,
            "tenant",
        );
        assert.equal(
            clasificar({
                metodo: "POST",
                ruta: "/api/pos/:empresa_id/cuentas/:id/cobrar",
                router: "api",
            })?.categoria,
            "tenant",
        );
    });

    it("una ruta nueva sin clasificar NO se acepta (ni con otro nombre de parámetro, ni fuera del router de la API)", () => {
        assert.equal(clasificar({ metodo: "GET", ruta: "/api/nuevo/:id", router: "api" }), null);
        assert.equal(
            clasificar({ metodo: "GET", ruta: "/api/nuevo/:empresaId", router: "api" }),
            null,
        );
        assert.equal(
            clasificar({ metodo: "GET", ruta: "/api/nuevo/:id/:empresa_id", router: "api" }),
            null,
        );
        assert.equal(
            clasificar({ metodo: "GET", ruta: "/api/auth/:empresa_id", router: "auth" }),
            null,
            "fuera del router con guardia no cuenta como tenant",
        );
        assert.equal(
            clasificar({ metodo: "DELETE", ruta: "/api/auth/me", router: "auth" }),
            null,
            "el método también cuenta",
        );
    });

    it("toda excepción lleva un motivo escrito", () => {
        for (const [k, v] of Object.entries(EXCEPCIONES))
            assert.ok(v.motivo?.length > 20, `La excepción ${k} necesita un motivo entendible`);
    });
});

describe("catálogo de rutas — inspector", () => {
    it("una app bien formada no reporta problemas", () => {
        const { app, montajes } = construir();
        const { problemas, rutas } = inspeccionar({ app, montajes });
        assert.deepEqual(problemas, []);
        assert.deepEqual(rutas.map((r) => `${r.metodo} ${r.ruta}`).sort(), [
            "GET /api/cosas/:empresa_id",
            "GET /health",
        ]);
    });

    it("un router montado en la app que el catálogo no conoce se reporta", () => {
        const { app, montajes } = construir({
            extra: (a) => a.use("/api/oculto", Router().get("/x", ok)),
        });
        const { problemas } = inspeccionar({ app, montajes });
        assert.ok(
            problemas.some((p) => /no está en el catálogo/.test(p)),
            problemas.join("\n"),
        );
    });

    it("un router del catálogo que no está montado se reporta", () => {
        const { app, montajes } = construir();
        const fantasma = { nombre: "fantasma", prefijo: "/api/fantasma", router: Router() };
        const { problemas } = inspeccionar({ app, montajes: [...montajes, fantasma] });
        assert.ok(
            problemas.some((p) => /«fantasma».*no está montado/.test(p)),
            problemas.join("\n"),
        );
    });

    it("perder o reordenar la cadena requireAuth → requireActiveUser → requirePasswordCurrent se reporta", () => {
        const sinPassword = construir({ ordenCadena: [requireAuth, requireActiveUser] });
        assert.ok(inspeccionar(sinPassword).problemas.some((p) => /debe ir detrás de/.test(p)));
        const desordenada = construir({
            ordenCadena: [requireActiveUser, requireAuth, requirePasswordCurrent],
        });
        assert.ok(inspeccionar(desordenada).problemas.some((p) => /debe ir detrás de/.test(p)));
        const sinNada = construir({ ordenCadena: [] });
        assert.ok(inspeccionar(sinNada).problemas.some((p) => /debe ir detrás de/.test(p)));
    });

    it("un router montado en otro prefijo del declarado se reporta", () => {
        const { app, api } = construir();
        const { problemas } = inspeccionar({
            app,
            montajes: [{ nombre: "api", prefijo: "/v2", router: api }],
        });
        assert.ok(
            problemas.some((p) => /no está montado en \/v2/.test(p)),
            problemas.join("\n"),
        );
    });

    it("router.use, router.all y rutas con path no textual dentro de un router se reportan (no se saltan en silencio)", () => {
        const conUse = construir({
            rutas: (r) => {
                r.get("/cosas/:empresa_id", ok);
                r.use("/dentro", Router().get("/x", ok));
            },
        });
        assert.ok(inspeccionar(conUse).problemas.some((p) => /no es ruta/.test(p)));
        const conAll = construir({ rutas: (r) => r.all("/cosas/:empresa_id", ok) });
        assert.ok(inspeccionar(conAll).problemas.some((p) => /router\.all/.test(p)));
        const conRegex = construir({ rutas: (r) => r.get(/^\/raro$/, ok) });
        assert.ok(inspeccionar(conRegex).problemas.some((p) => /no textual/.test(p)));
    });

    it("un middleware con ruta propia que no es de autenticación (podría servir endpoints) se reporta", () => {
        const { app, montajes } = construir({
            extra: (a) =>
                a.use("/api/atajo", function atajo(_q, r) {
                    r.json({});
                }),
        });
        assert.ok(
            inspeccionar({ app, montajes }).problemas.some((p) =>
                /ruta propia desconocido «atajo»/.test(p),
            ),
        );
    });

    it("un middleware global desconocido se reporta", () => {
        const { app, montajes } = construir({
            extra: (a) =>
                a.use(function sorpresa(_q, _r, n) {
                    n();
                }),
        });
        assert.ok(
            inspeccionar({ app, montajes }).problemas.some((p) =>
                /global desconocido «sorpresa»/.test(p),
            ),
        );
    });
});

describe("catálogo de rutas — router.use conocidos", () => {
    const guardaAgente = function requireAgente(_q, _r, n) {
        n();
    };
    const montajeAgente = (rutas) => {
        const router = Router();
        rutas(router);
        const app = express();
        app.use("/api/agente", router);
        return {
            app,
            montajes: [
                {
                    nombre: "agente",
                    prefijo: "/api/agente",
                    router,
                    capasUso: [{ nombre: "requireAgente", fn: guardaAgente }],
                },
            ],
        };
    };

    it("las rutas registradas DESPUÉS del router.use conocido llevan su etiqueta; las anteriores, no", () => {
        const cfg = montajeAgente((r) => {
            r.post("/emparejar", ok);
            r.use(guardaAgente);
            r.get("/version", ok);
        });
        const { rutas, problemas } = inspeccionar(cfg);
        assert.deepEqual(problemas, []);
        assert.ok(
            rutas.find((r) => r.ruta === "/api/agente/version").mw.includes("use:requireAgente"),
        );
        assert.ok(
            !rutas.find((r) => r.ruta === "/api/agente/emparejar").mw.includes("use:requireAgente"),
        );
    });

    it("mover /version POR ENCIMA del router.use la deja sin guardia y la validación lo reporta", () => {
        const cfg = montajeAgente((r) => {
            r.get("/version", ok);
            r.use(guardaAgente);
            r.get("/impresiones/pendientes", ok);
        });
        const p = validarClasificacion(inspeccionar(cfg));
        assert.ok(
            p.some((x) =>
                /GET \/api\/agente\/version: debería llevar el middleware use:requireAgente/.test(
                    x,
                ),
            ),
            p.join("\n"),
        );
    });

    it("un router.use que NO está declarado se reporta", () => {
        const otra = function otra(_q, _r, n) {
            n();
        };
        const cfg = montajeAgente((r) => {
            r.use(otra);
            r.get("/version", ok);
        });
        assert.ok(inspeccionar(cfg).problemas.some((p) => /debe declararse en capasUso/.test(p)));
    });
});

describe("catálogo de rutas — validación de la clasificación", () => {
    const validar = (cfg) => validarClasificacion(inspeccionar(cfg));

    it("una ruta nueva sin clasificar hace fallar, con su nombre", () => {
        const cfg = construir({
            rutas: (r) => {
                r.get("/cosas/:empresa_id", ok);
                r.get("/ventas-nuevas/:id", ok);
            },
        });
        const p = validar(cfg);
        assert.ok(
            p.some((x) => x.startsWith("SIN CLASIFICAR: GET /api/ventas-nuevas/:id")),
            p.join("\n"),
        );
    });

    it("una ruta tenant en un router SIN empresaGuard hace fallar", () => {
        const cfg = construir({ guardia: false });
        const p = validar(cfg);
        assert.ok(
            p.some((x) => /no tiene empresaGuard en router\.param\("empresa_id"\)/.test(x)),
            p.join("\n"),
        );
    });

    it("una excepción que ya no corresponde a ninguna ruta se reporta (la lista no se pudre)", () => {
        const p = validar(construir());
        assert.ok(
            p.some((x) =>
                x.includes("La excepción «POST /api/platform/empresas» ya no corresponde"),
            ),
        );
    });

    it("una excepción cuya ruta perdió el middleware que debía llevar se reporta", () => {
        const cfg = construir({
            rutas: (r) => {
                r.get("/cosas/:empresa_id", ok);
                r.get("/platform/empresas", ok);
            },
        });
        const p = validar(cfg);
        assert.ok(
            p.some((x) =>
                /GET \/api\/platform\/empresas: debería llevar el middleware requirePlatformAdmin/.test(
                    x,
                ),
            ),
            p.join("\n"),
        );
    });
});
