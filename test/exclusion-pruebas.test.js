import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regla (ver test/helpers/exclusion.js): los archivos de prueba corren en paralelo contra la MISMA base.
//   · el que mide la huella de una empresa debe tomar el candado COMPARTIDO;
//   · el que ejecuta algo global (migración, DDL, rol migrador) debe tomar el EXCLUSIVO.
// Sin esta regla, un archivo nuevo vuelve a producir el falso «B modificó datos de A» (solo de vez en cuando, y solo en CI).

const archivos = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) return e.name === "helpers" ? [] : archivos(ruta);
        return e.name.endsWith(".test.js") ? [ruta] : [];
    });

const PROPIO = "exclusion-pruebas.test.js";
const todos = archivos("test").filter((f) => !f.endsWith(PROPIO));
const leer = (f) => readFileSync(f, "utf8");

describe("exclusión entre archivos de prueba que comparten la base", () => {
    it("quien mide huellas de una empresa toma el candado compartido", () => {
        const sin = todos.filter((f) => {
            const s = leer(f);
            return (
                /\b(huellaEmpresas|descubrirAlcance)\b/.test(s) && !/\btomarCompartido\(/.test(s)
            );
        });
        assert.deepEqual(
            sin,
            [],
            `Estos archivos miden huellas sin \`tomarCompartido()\` (test/helpers/exclusion.js):\n${sin.join("\n")}`,
        );
    });

    it("quien ejecuta algo global (migración, DDL, rol migrador) toma el candado exclusivo", () => {
        const sin = todos.filter((f) => {
            const s = leer(f);
            const global =
                /\bcrearPoolMigrador\b/.test(s) || /readFileSync\([^)]*db\/migrations\//.test(s);
            return global && !/\btomarExclusivo\(/.test(s);
        });
        assert.deepEqual(
            sin,
            [],
            `Estos archivos ejecutan algo global sin \`tomarExclusivo()\` (test/helpers/exclusion.js):\n${sin.join("\n")}`,
        );
    });

    it("el mismo archivo no toma los dos candados (se bloquearía a sí mismo esperando sus propias lecturas)", () => {
        const ambos = todos.filter((f) => {
            const s = leer(f);
            return /\btomarCompartido\(/.test(s) && /\btomarExclusivo\(/.test(s);
        });
        assert.deepEqual(ambos, []);
    });

    it("la regla ve los archivos que conocemos (no pasa por vacío)", () => {
        const nombres = todos.map((f) => f.split("/").pop());
        for (const esperado of [
            "aislamiento-dinamico.test.js",
            "categorias.test.js",
            "rol-aplicacion.test.js",
        ])
            assert.ok(nombres.includes(esperado), `no encontré ${esperado}`);
    });
});
