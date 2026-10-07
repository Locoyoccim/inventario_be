import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluarEventos } from "../scripts/ci/guardia-ci.js";

const pasa = (file, name = "t") => ({ type: "test:pass", data: { file, name, details: { type: "test" } } });

describe("guardia de CI: análisis de eventos", () => {
    it("una corrida completa y sin omisiones es válida", () => {
        const r = evaluarEventos([pasa("/t/a.test.js"), pasa("/t/b.test.js")], ["/t/a.test.js", "/t/b.test.js"]);
        assert.deepEqual(r, { omitidas: [], sinEjecutar: [] });
    });

    it("una prueba omitida (skip con motivo o true) invalida la corrida", () => {
        const r = evaluarEventos(
            [pasa("/t/a.test.js"), { type: "test:pass", data: { file: "/t/a.test.js", name: "x", skip: "define TEST_DATABASE_URL" } }, { type: "test:pass", data: { file: "/t/a.test.js", name: "y", skip: true } }],
            ["/t/a.test.js"],
        );
        assert.equal(r.omitidas.length, 2);
        assert.match(r.omitidas[0], /x \(omitida: define TEST_DATABASE_URL\)/);
    });

    it("una suite entera omitida (describe con skip) invalida la corrida y se nombra", () => {
        const r = evaluarEventos([{ type: "test:pass", data: { file: "/t/a.test.js", name: "Integración", skip: "define TEST_DATABASE_URL", details: { type: "suite" } } }], ["/t/a.test.js"]);
        assert.equal(r.omitidas.length, 1);
        assert.match(r.omitidas[0], /Integración \(omitida: define TEST_DATABASE_URL\)/);
    });

    it("una prueba pendiente (todo) invalida la corrida", () => {
        const r = evaluarEventos([pasa("/t/a.test.js"), { type: "test:pass", data: { file: "/t/a.test.js", name: "z", todo: true } }], ["/t/a.test.js"]);
        assert.equal(r.omitidas.length, 1);
    });

    it("un archivo de pruebas que no ejecutó nada (suite que desaparece) invalida la corrida", () => {
        const r = evaluarEventos([pasa("/t/a.test.js")], ["/t/a.test.js", "/t/b.test.js"]);
        assert.deepEqual(r.sinEjecutar, ["/t/b.test.js"]);
    });

    it("un archivo cuyas pruebas solo fallaron o se omitieron cuenta como no ejecutado", () => {
        const r = evaluarEventos([{ type: "test:fail", data: { file: "/t/b.test.js", name: "q", details: { type: "test" } } }], ["/t/b.test.js"]);
        assert.deepEqual(r.sinEjecutar, ["/t/b.test.js"]);
    });
});

describe("guardia de CI: de punta a punta con el runner real", () => {
    const guardia = resolve("scripts/ci/guardia-ci.js");
    const correr = (cuerpo) => {
        const dir = mkdtempSync(join(tmpdir(), "guardia-"));
        try {
            mkdirSync(join(dir, "test"));
            writeFileSync(join(dir, "test", "muestra.test.js"), `import { it } from "node:test";\n${cuerpo}\n`);
            return spawnSync(process.execPath, ["--test", `--test-reporter=${guardia}`, "--test-reporter-destination=stderr"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };

    it("una prueba omitida a propósito deja la corrida en rojo (exit 1) y la nombra", () => {
        const r = correr(`it("ok", () => {});\nit("omitida", { skip: "motivo de prueba" }, () => {});`);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /OMITIDA/);
        assert.match(r.stderr, /omitida \(omitida: motivo de prueba\)/);
    });

    it("sin omisiones la corrida queda en verde (exit 0)", () => {
        const r = correr(`it("ok", () => {});`);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr.trim(), "");
    });
});
