import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    analizar,
    compararConBaseline,
    extraerConsultas,
    huellaDe,
    pendientesDeRevision,
} from "./helpers/escanerSql.js";

// Controles NEGATIVOS de la prueba C (regresión del SQL multiempresa) con código y esquema de mentira, sin base de datos.
// La prueba contra el código real está en test/integration/aislamiento-sql.test.js.

const esquema = {
    todas: new Set(["cosas", "cosas_detalle", "otras", "empresas", "roles"]),
    conEmpresa: new Set(["cosas", "otras"]),
};

describe("escáner de SQL multiempresa", () => {
    let dir;
    const escribir = (nombre, texto) => writeFileSync(join(dir, nombre), texto);
    const escanear = () => pendientesDeRevision(extraerConsultas(dir), esquema);

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "escaner-sql-"));
        mkdirSync(join(dir, "m"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("una consulta que toca una tabla con empresa_id SIN filtrarla queda pendiente", () => {
        escribir("a.js", 'export const q = "SELECT * FROM cosas WHERE id = $1";\n');
        const p = escanear();
        assert.equal(p.length, 1);
        assert.deepEqual(p[0].tenant, ["cosas"]);
    });

    it("filtrar por empresa_id (condición o columna de INSERT) NO la deja pendiente; solo mencionarlo en el SELECT, sí", () => {
        escribir(
            "a.js",
            [
                'export const a = "SELECT * FROM cosas WHERE id = $1 AND empresa_id = $2";',
                'export const b = "UPDATE cosas SET x = 1 WHERE empresa_id = $2 AND id = $1";',
                'export const c = "INSERT INTO cosas (empresa_id, x) VALUES ($1, $2)";',
                'export const d = "SELECT * FROM cosas c JOIN otras o ON o.empresa_id = c.empresa_id WHERE c.id = $1";',
                'export const e = "SELECT id, empresa_id FROM cosas WHERE id = $1";',
            ].join("\n"),
        );
        const p = escanear();
        assert.equal(p.length, 1, JSON.stringify(p.map((x) => x.sql)));
        assert.match(p[0].sql, /SELECT id, empresa_id FROM cosas WHERE id = \$1/);
    });

    it("resuelve constantes de texto del archivo: un filtro dentro de una constante interpolada cuenta", () => {
        escribir(
            "a.js",
            [
                "const BASE = `SELECT * FROM cosas WHERE empresa_id = $1`;",
                "export const q = `SELECT x.* FROM (${BASE}) x WHERE x.id = $2`;",
            ].join("\n"),
        );
        assert.equal(escanear().length, 0);
    });

    it("una tabla hija (sin empresa_id) consultada sola queda pendiente de revisión", () => {
        escribir("a.js", 'export const q = "SELECT * FROM cosas_detalle WHERE cosa_id = $1";\n');
        const p = escanear();
        assert.equal(p.length, 1);
        assert.equal(p[0].tipo, "solo-tablas-hijas");
    });

    it("la huella ignora espacios y mayúsculas, pero cambia si cambia la consulta", () => {
        assert.equal(
            huellaDe("SELECT  *\n FROM cosas WHERE id = $1"),
            huellaDe("select * from cosas where id = $1"),
        );
        assert.notEqual(
            huellaDe("SELECT * FROM cosas WHERE id = $1"),
            huellaDe("SELECT * FROM cosas WHERE id = $1 OR true"),
        );
    });

    it("el análisis reconoce tablas y catálogos globales", () => {
        const a = analizar(
            "SELECT * FROM roles r JOIN cosas c ON c.role = r.id WHERE c.empresa_id = $1",
            esquema,
        );
        assert.deepEqual(a.tenant, ["cosas"]);
        assert.equal(a.filtra, true);
    });

    describe("comparación con la línea base", () => {
        const consulta = {
            archivo: "src/x.js",
            huella: "aaaaaaaaaaaa",
            ocurrencias: 1,
            metodo: "m",
            tablas: ["cosas"],
            sql: "SELECT * FROM cosas WHERE id = $1",
            lineas: [10],
        };
        const entrada = {
            archivo: "src/x.js",
            huella: "aaaaaaaaaaaa",
            ocurrencias: 1,
            metodo: "m",
            categoria: "segundo-paso-tras-guardia",
            motivo: "Segundo paso de m(): la cuenta ya se verificó con empresa_id antes de llegar a esta consulta.",
            guardia: "SELECT … AND empresa_id = $2",
        };
        const baseline = (...entradas) => ({
            categorias: { "segundo-paso-tras-guardia": "x" },
            consultas: entradas,
        });

        it("todo revisado y vigente → sin problemas", () => {
            assert.deepEqual(compararConBaseline([consulta], baseline(entrada)), []);
        });

        it("SQL nuevo sin revisar → falla y explica cómo resolverlo", () => {
            const p = compararConBaseline(
                [consulta, { ...consulta, huella: "bbbbbbbbbbbb", lineas: [20] }],
                baseline(entrada),
            );
            assert.equal(p.length, 1);
            assert.match(p[0], /SQL SIN REVISAR en src\/x\.js:20/);
            assert.match(p[0], /tenant-sql\.baseline\.json/);
        });

        it("una consulta revisada que se MODIFICA (otra huella) vuelve a exigir revisión y deja obsoleta la entrada", () => {
            const p = compararConBaseline(
                [{ ...consulta, huella: "cccccccccccc" }],
                baseline(entrada),
            );
            assert.ok(p.some((x) => /SQL SIN REVISAR/.test(x)));
            assert.ok(p.some((x) => /Entrada obsoleta/.test(x)));
        });

        it("una copia adicional de una consulta ya revisada → falla", () => {
            const p = compararConBaseline(
                [{ ...consulta, ocurrencias: 2, lineas: [10, 40] }],
                baseline(entrada),
            );
            assert.ok(
                p.some((x) => /2 ocurrencia\(s\).*se revisaron 1/.test(x)),
                p.join("\n"),
            );
        });

        it("entradas obsoletas, sin motivo auditable, sin categoría o sin guardia → fallan", () => {
            assert.ok(
                compararConBaseline([], baseline(entrada)).some((x) => /Entrada obsoleta/.test(x)),
            );
            assert.ok(
                compararConBaseline([consulta], baseline({ ...entrada, motivo: "ok" })).some((x) =>
                    /demasiado corto/.test(x),
                ),
            );
            assert.ok(
                compararConBaseline(
                    [consulta],
                    baseline({ ...entrada, categoria: "inventada" }),
                ).some((x) => /no definida/.test(x)),
            );
            assert.ok(
                compararConBaseline([consulta], baseline({ ...entrada, guardia: "" })).some((x) =>
                    /falta citar la guardia/.test(x),
                ),
            );
        });
    });
});
