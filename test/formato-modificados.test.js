import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { elegirDesde } from "../scripts/formato_modificados.js";

const script = resolve("scripts/formato_modificados.js");
const MAL = "const a = {b:1,   c:2}\n"; // sin formato (comillas, espacios, sin punto y coma)
const BIEN = "const a = { b: 1, c: 2 };\n";

describe("trinquete de formato: elección del punto de partida (función pura)", () => {
    const base = {
        ancestroComun: "AAA",
        trinquete: "TTT",
        trinqueteExiste: true,
        ancestroComunEsAnteriorAlTrinquete: true,
        trinqueteEsAncestroDeHead: true,
    };
    it("manda el commit del trinquete si está entre el ancestro común y HEAD", () =>
        assert.equal(elegirDesde(base), "TTT"));
    it("sin trinquete, o con un commit que ya no existe (squash), se usa el ancestro común", () => {
        assert.equal(elegirDesde({ ...base, trinquete: "" }), "AAA");
        assert.equal(elegirDesde({ ...base, trinqueteExiste: false }), "AAA");
    });
    it("si el trinquete no es ancestro de HEAD o el ancestro común es POSTERIOR al trinquete, se usa el ancestro común", () => {
        assert.equal(elegirDesde({ ...base, trinqueteEsAncestroDeHead: false }), "AAA");
        assert.equal(elegirDesde({ ...base, ancestroComunEsAnteriorAlTrinquete: false }), "AAA");
    });
});

describe("trinquete de formato: de punta a punta en repositorios temporales", () => {
    let raizTmp;
    before(() => {
        raizTmp = mkdtempSync(join(tmpdir(), "formato-"));
    });
    after(() => rmSync(raizTmp, { recursive: true, force: true }));

    let n = 0;
    const g = (dir, ...args) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
            cwd: dir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    const poner = (dir, archivo, texto) => writeFileSync(join(dir, archivo), texto);
    const commit = (dir, mensaje) => {
        g(dir, "add", "-A");
        g(dir, "commit", "-q", "-m", mensaje);
        return g(dir, "rev-parse", "HEAD");
    };
    // main con un archivo SIN formato ya existente (el «pasado» que no se exige arreglar) y una rama de trabajo.
    const repo = () => {
        const dir = join(raizTmp, `r${++n}`);
        mkdirSync(dir);
        g(dir, "init", "-q", "-b", "main");
        poner(dir, ".prettierrc.json", "{}\n");
        poner(dir, "viejo.js", MAL);
        poner(dir, "bien.js", BIEN);
        commit(dir, "base");
        g(dir, "checkout", "-q", "-b", "trabajo");
        return dir;
    };
    const correr = (dir, ...args) =>
        spawnSync(process.execPath, [script, ...args], {
            cwd: dir,
            encoding: "utf8",
            env: { PATH: process.env.PATH, HOME: process.env.HOME },
        });
    const salida = (r) => r.stdout + r.stderr;

    it("un archivo nuevo sin formato falla, se nombra, y los viejos sin formato que no se tocaron NO se exigen", () => {
        const dir = repo();
        poner(dir, "nuevo_mal.js", MAL);
        poner(dir, "nuevo_bien.js", BIEN);
        commit(dir, "trabajo");
        const r = correr(dir);
        assert.equal(r.status, 1, salida(r));
        assert.match(r.stderr, /✖ nuevo_mal\.js/);
        assert.doesNotMatch(salida(r), /nuevo_bien\.js|viejo\.js/);
    });

    it("solo archivos formateados (o ninguno cambiado) pasa, aunque el repositorio tenga código viejo sin formato", () => {
        const dir = repo();
        let r = correr(dir);
        assert.equal(r.status, 0, salida(r));
        assert.match(r.stdout, /ningún archivo modificado/);
        poner(dir, "nuevo_bien.js", BIEN);
        commit(dir, "trabajo");
        r = correr(dir);
        assert.equal(r.status, 0, salida(r));
        assert.match(r.stdout, /1 archivo\(s\) modificados .* están formateados/);
    });

    it("al MODIFICAR un archivo viejo sin formato, ese archivo sí se exige (trinquete: lo que tocas queda bien)", () => {
        const dir = repo();
        poner(dir, "viejo.js", MAL + "const z = 1\n");
        commit(dir, "toco el viejo");
        const r = correr(dir);
        assert.equal(r.status, 1, salida(r));
        assert.match(r.stderr, /✖ viejo\.js/);
    });

    it("también se comprueban los cambios sin commitear y los archivos nuevos sin seguimiento", () => {
        const dir = repo();
        poner(dir, "sin_seguimiento.js", MAL);
        poner(dir, "bien.js", BIEN + "const y = 2;\n");
        poner(dir, "viejo.js", MAL + "// editado\n");
        const r = correr(dir);
        assert.equal(r.status, 1, salida(r));
        assert.match(r.stderr, /✖ sin_seguimiento\.js/);
        assert.match(r.stderr, /✖ viejo\.js/);
        assert.doesNotMatch(r.stderr, /✖ bien\.js/);
    });

    it("--write formatea SOLO los modificados: el resto queda byte a byte igual y la comprobación pasa", () => {
        const dir = repo();
        poner(dir, "nuevo_mal.js", MAL);
        commit(dir, "trabajo");
        const viejoAntes = readFileSync(join(dir, "viejo.js"), "utf8");
        const w = correr(dir, "--write");
        assert.equal(w.status, 0, salida(w));
        assert.equal(
            readFileSync(join(dir, "nuevo_mal.js"), "utf8"),
            BIEN,
            "el modificado quedó formateado",
        );
        assert.equal(
            readFileSync(join(dir, "viejo.js"), "utf8"),
            viejoAntes,
            "el viejo sin tocar NO se reformatea",
        );
        assert.equal(readFileSync(join(dir, "viejo.js"), "utf8"), MAL);
        assert.equal(correr(dir).status, 0);
    });

    it(".prettier-ratchet: lo commiteado ANTES del trinquete no se exige, lo posterior sí", () => {
        const dir = repo();
        poner(dir, "anterior.js", MAL); // trabajo previo al trinquete
        const antes = commit(dir, "trabajo previo");
        poner(dir, ".prettier-ratchet", `# el formato se exige desde aquí\n${antes}\n`);
        poner(dir, "inicio.js", BIEN);
        commit(dir, "agrega el trinquete");
        poner(dir, "posterior.js", MAL);
        commit(dir, "trabajo posterior");
        const r = correr(dir);
        assert.equal(r.status, 1, salida(r));
        assert.match(r.stderr, /✖ posterior\.js/);
        assert.doesNotMatch(salida(r), /anterior\.js/);
        assert.match(r.stderr, /inicio del trinquete/);
    });

    it("si el commit anotado ya no existe (squash merge) se ignora y se usa el ancestro común", () => {
        const dir = repo();
        poner(dir, ".prettier-ratchet", "0123456789abcdef0123456789abcdef01234567\n");
        poner(dir, "anterior.js", MAL);
        commit(dir, "trabajo");
        const r = correr(dir);
        assert.equal(r.status, 1, salida(r));
        assert.match(r.stderr, /✖ anterior\.js/);
    });

    it("respeta .prettierignore y no falla con archivos de tipos que Prettier no conoce", () => {
        const dir = repo();
        poner(dir, ".prettierignore", "generado.js\n");
        poner(dir, "generado.js", MAL);
        poner(dir, "datos.bin", "\u0000\u0001\u0002");
        poner(dir, "NOTAS", "texto sin extensión\n");
        commit(dir, "trabajo");
        const r = correr(dir);
        assert.equal(r.status, 0, salida(r));
    });

    it("sin rama base reconocible falla con un mensaje claro (código 2), no con un falso «todo bien»", () => {
        const dir = join(raizTmp, `sin-base${++n}`);
        mkdirSync(dir);
        g(dir, "init", "-q", "-b", "trunk");
        poner(dir, "a.js", MAL);
        commit(dir, "unico");
        const r = correr(dir);
        assert.equal(r.status, 2, salida(r));
        assert.match(r.stderr, /FORMATO_BASE/);
        assert.equal(correr(dir, "trunk").status, 0, "con la base indicada funciona");
    });
});
