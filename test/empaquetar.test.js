import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listarZip, rutasProhibidas } from "../scripts/empaquetar.js";

const script = resolve("scripts/empaquetar.js");

describe("empaquetar: rutas prohibidas", () => {
    it("detecta .env, claves, volcados, respaldos y dependencias; permite .env.example y las migraciones .sql", () => {
        const malas = [".env", "api/.env.local", ".env.production", ".env.test", ".env.example.bak", ".env.test.local", "cert/servidor.pem", "ssh/id_rsa", "backup.dump", "datos.sqlite3", "x.bak", "scripts/limpiar.sql", "backups/2026.sql", "node_modules/a/b.js", "build.zip"];
        const buenas = [".env.example", ".env.sample", ".env.test.example", "api/.env.production.template", "db/migrations/001_init.sql", "src/app.js", "docs/ENV.md", "ssh/id_rsa.pub.txt", "src/env.js"];
        const r = rutasProhibidas([...malas, ...buenas]).map((x) => x.ruta);
        assert.deepEqual(r.sort(), [...malas].sort());
    });
});

describe("empaquetar: de punta a punta en repositorios temporales", () => {
    let base;
    before(() => {
        base = mkdtempSync(join(tmpdir(), "empaquetar-"));
    });
    after(() => rmSync(base, { recursive: true, force: true }));

    const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const escribir = (cwd, ruta, texto) => {
        mkdirSync(dirname(join(cwd, ruta)), { recursive: true });
        writeFileSync(join(cwd, ruta), texto);
    };
    const repo = (nombre, archivos = {}) => {
        const dir = join(base, nombre);
        mkdirSync(dir);
        g(dir, "init", "-q");
        escribir(dir, ".gitignore", ".env\ndist\n");
        escribir(dir, "README.md", "# hola\n");
        escribir(dir, ".env.example", "JWT_SECRET=<genera-uno>\n");
        for (const [r, t] of Object.entries(archivos)) escribir(dir, r, t);
        g(dir, "add", "-A");
        for (const r of Object.keys(archivos)) g(dir, "add", "-f", r); // simula el error: versionar a la fuerza algo ignorado
        g(dir, "commit", "-q", "-m", "inicial");
        return dir;
    };
    const correr = (cwd) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const SECRETO = "valor-super-secreto-12345";

    it("con el árbol limpio genera el ZIP, sin .env aunque exista localmente, y no hace commits", () => {
        const dir = repo("limpio");
        escribir(dir, ".env", `JWT_SECRET=${SECRETO}\n`); // ignorado por git
        const antes = g(dir, "rev-parse", "HEAD");
        const r = correr(dir);
        assert.equal(r.status, 0, r.stderr);
        const zip = join(dir, "dist", `limpio-${antes.trim().slice(0, 7)}.zip`);
        assert.ok(existsSync(zip), `falta ${zip}: ${r.stdout}`);
        const nombres = listarZip(readFileSync(zip));
        assert.ok(nombres.includes("limpio/README.md"));
        assert.ok(nombres.includes("limpio/.env.example"));
        assert.ok(!nombres.some((n) => /\/\.env$/.test(n)), "el .env local no debe viajar");
        assert.equal(g(dir, "rev-parse", "HEAD"), antes, "el script no debe crear commits");
        assert.equal(g(dir, "status", "--porcelain").trim(), "", "el script no debe ensuciar el árbol");
    });

    it("con cambios sin commitear (modificados o nuevos) se NIEGA y no genera ZIP", () => {
        for (const [nombre, tocar] of [["sucio-mod", (d) => escribir(d, "README.md", "cambio\n")], ["sucio-nuevo", (d) => escribir(d, "nuevo.js", "x\n")]]) {
            const dir = repo(nombre);
            tocar(dir);
            const r = correr(dir);
            assert.equal(r.status, 1, nombre);
            assert.match(r.stderr, /cambios sin commitear/);
            assert.ok(!existsSync(join(dir, "dist")), "no debe generar el ZIP");
        }
    });

    it("si un valor del .env local está copiado en un archivo versionado, se niega y NO imprime el valor", () => {
        const dir = repo("fuga", { "config/prod.js": `export const s = "${SECRETO}";\n` });
        escribir(dir, ".env", `JWT_SECRET=${SECRETO}\nPIN_PEPPER=otro-valor-distinto-9999\n`);
        const r = correr(dir);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /config\/prod\.js/);
        assert.match(r.stderr, /aparece en archivos versionados/);
        assert.ok(!(r.stdout + r.stderr).includes(SECRETO), "el valor del secreto no debe imprimirse");
        assert.ok(!existsSync(join(dir, "dist")));
    });

    it("si un .env quedó versionado por error, el ZIP se rechaza por la revisión de contenido", () => {
        const dir = repo("env-versionado", { "api/.env": "X=1\n" }); // .gitignore lo ignora; se versiona a la fuerza
        const r = correr(dir);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stderr, /PROHIBIDO\s+api\/\.env/);
        assert.match(r.stderr, /NO debe entregarse/);
    });

    it("sin .gitignore para dist/ se niega (el siguiente paquete vería el árbol sucio)", () => {
        const dir = repo("sin-ignore");
        writeFileSync(join(dir, ".gitignore"), ".env\n");
        g(dir, "add", "-A");
        g(dir, "commit", "-q", "-m", "quita dist");
        const r = correr(dir);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /dist\/ no está en \.gitignore/);
    });

    it("fuera de un repositorio git se niega", () => {
        const dir = join(base, "sin-git");
        mkdirSync(dir);
        const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CEILING_DIRECTORIES: base } });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /no es un repositorio git/);
    });
});
