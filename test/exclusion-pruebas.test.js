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

    it("dos archivos no comparten un id de empresa fijo (uno limpiaría los datos del otro mientras corren en paralelo)", () => {
        // Ids de fixture declarados como `const A = 9421;`, `const [A, B] = [9901, 9902];` o `const IDS = [9861, 9862];`.
        const dueno = new Map();
        const choques = [];
        for (const f of todos) {
            const propios = new Set();
            for (const linea of leer(f).split("\n")) {
                if (!/^\s*const\s+[^=]*=\s*[[\d]/.test(linea)) continue;
                for (const n of linea.match(/\b9\d{3}\b/g) ?? []) propios.add(n);
            }
            for (const n of propios) {
                if (dueno.has(n)) choques.push(`${n}: ${dueno.get(n)} y ${f}`);
                else dueno.set(n, f);
            }
        }
        assert.deepEqual(
            choques,
            [],
            `Ids de empresa repetidos entre archivos:\n${choques.join("\n")}`,
        );
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
