import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVENTOS } from "../src/utils/seguridad.js";

// docs/OBSERVABILIDAD.md es lo que alguien lee a las 3 de la mañana: sus tablas no pueden separarse del código. Sin base de datos.

const DOC = readFileSync("docs/OBSERVABILIDAD.md", "utf8");

/** Lo que hay entre dos encabezados «### …» (o hasta el siguiente «## »). */
function seccion(titulo) {
    const i = DOC.indexOf(titulo);
    assert.ok(i >= 0, `falta la sección «${titulo}» en el documento`);
    const resto = DOC.slice(i + titulo.length);
    const fin = resto.search(/\n#{2,3} /);
    return fin < 0 ? resto : resto.slice(0, fin);
}
const filas = (texto) => [...texto.matchAll(/^\|\s*`([a-z_]+)`/gm)].map((m) => m[1]);

const archivos = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
            ? archivos(join(dir, e.name))
            : e.name.endsWith(".js")
              ? [join(dir, e.name)]
              : [],
    );
const FUENTE = [...archivos("src"), "server.js"].map((f) => readFileSync(f, "utf8")).join("\n");

describe("docs/OBSERVABILIDAD.md y el código", () => {
    it("la tabla de eventos de seguridad tiene exactamente los del catálogo (sin faltar ni sobrar)", () => {
        const enDoc = filas(seccion("### Eventos de seguridad"));
        const enCodigo = Object.keys(EVENTOS);
        assert.deepEqual(
            enCodigo.filter((e) => !enDoc.includes(e)),
            [],
            "eventos del catálogo que el documento no explica",
        );
        assert.deepEqual(
            enDoc.filter((e) => !enCodigo.includes(e)),
            [],
            "eventos que el documento menciona y ya no existen",
        );
        assert.equal(new Set(enDoc).size, enDoc.length, "una fila repetida");
    });

    it("cada evento de «Otros eventos del log» lo emite alguna línea del código, y cada evento que el código emite está documentado", () => {
        const otros = filas(seccion("### Otros eventos del log"));
        assert.ok(otros.length >= 10);
        for (const nombre of otros) {
            const emitido = new RegExp(`["'\`]${nombre}["'\`]`).test(FUENTE);
            assert.ok(emitido, `«${nombre}» está en el documento pero el código no lo emite`);
        }
        // Al revés: todo nombre de evento pasado al logger (log.error("x"), logger.warn("x")...) está en alguna tabla.
        const conocidos = new Set([...otros, ...Object.keys(EVENTOS), "security"]);
        const emitidos = new Set(
            [...FUENTE.matchAll(/\b(?:logger|log)\.(?:info|warn|error)\(\s*"([a-z_]+)"/g)].map(
                (m) => m[1],
            ),
        );
        // Los eventos de seguridad se emiten con registrarEvento(); estos son los demás.
        const sinDocumentar = [...emitidos].filter((e) => !conocidos.has(e));
        assert.deepEqual(
            sinDocumentar,
            [],
            `el código emite eventos que el documento no explica: ${sinDocumentar}`,
        );
    });

    it("las alertas de la tabla de umbrales solo nombran eventos que existen", () => {
        const alertas = seccion("## 4. Qué debe alertar");
        const todos = new Set([
            ...Object.keys(EVENTOS),
            ...filas(seccion("### Otros eventos del log")),
        ]);
        const nombrados = [...alertas.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
        const desconocidos = [...new Set(nombrados)].filter(
            (n) => !todos.has(n) && !["x_request_id"].includes(n),
        );
        assert.deepEqual(
            desconocidos,
            [],
            `alertas que nombran eventos inexistentes: ${desconocidos}`,
        );
    });

    it("el documento explica cómo apagar y encender Sentry y menciona las variables reales", () => {
        for (const variable of ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE"])
            assert.match(DOC, new RegExp(variable));
        assert.match(FUENTE, /SENTRY_ENVIRONMENT/);
        assert.match(FUENTE, /SENTRY_RELEASE/);
    });
});
