import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluarEnv, problemasDeSecretos, SECRETOS_CONOCIDOS } from "../src/config/env.js";

const nuevo = (bytes = 48) => randomBytes(bytes).toString("base64url");
const prod = (extra = {}) => ({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://app@localhost:5432/x",
    CORS_ORIGINS: "https://app.ejemplo.mx",
    JWT_SECRET: nuevo(),
    SETUP_TOKEN: nuevo(24),
    PIN_PEPPER: nuevo(),
    ...extra,
});

describe("validación de la configuración: producción", () => {
    it("una configuración correcta no tiene problemas", () => {
        assert.deepEqual(evaluarEnv(prod()), []);
    });

    it("rechaza TODOS los secretos conocidos del repositorio como JWT_SECRET", () => {
        for (const conocido of SECRETOS_CONOCIDOS) {
            const p = evaluarEnv(prod({ JWT_SECRET: conocido }));
            assert.ok(p.some((m) => /JWT_SECRET parece un valor de ejemplo/.test(m)) || p.some((m) => /al menos 32/.test(m)), `debería rechazar «${conocido}»`);
        }
    });

    it("rechaza las variantes de un texto de ejemplo (cambiar un carácter no lo salva) y los marcadores <...>", () => {
        const variantes = ["Cambia-Esto-Por-Un-Secreto-Largo-Y-Aleatorio-2", "un_secreto_de_al_menos_32_caracteres_aqui!", "<genera-uno-de-48-bytes-aleatorios-ok>", "  ci-secret-no-usar-en-produccion-xx  "];
        for (const v of variantes) {
            assert.ok(evaluarEnv(prod({ JWT_SECRET: v })).some((m) => /JWT_SECRET parece un valor de ejemplo/.test(m)), `debería rechazar «${v}»`);
        }
    });

    it("rechaza secretos repetitivos y cortos", () => {
        assert.ok(evaluarEnv(prod({ JWT_SECRET: "a".repeat(64) })).some((m) => /JWT_SECRET es demasiado repetitivo/.test(m)));
        assert.ok(evaluarEnv(prod({ JWT_SECRET: "abcabcabc".repeat(8) })).some((m) => /demasiado repetitivo/.test(m)));
        assert.ok(evaluarEnv(prod({ JWT_SECRET: nuevo(8) })).some((m) => /JWT_SECRET debe tener al menos 32/.test(m)));
        assert.ok(evaluarEnv(prod({ SETUP_TOKEN: nuevo(8) })).some((m) => /SETUP_TOKEN debe tener al menos 24/.test(m)));
    });

    it("un secreto hexadecimal normal (openssl rand -hex 16, 32 caracteres) sí es aceptado", () => {
        assert.deepEqual(evaluarEnv(prod({ JWT_SECRET: randomBytes(16).toString("hex") })), []);
        assert.deepEqual(evaluarEnv(prod({ JWT_SECRET: randomBytes(32).toString("hex") })), []);
    });

    it("PIN_PEPPER es obligatorio y distinto de JWT_SECRET y de SETUP_TOKEN", () => {
        const sin = prod();
        delete sin.PIN_PEPPER;
        assert.ok(evaluarEnv(sin).some((m) => /PIN_PEPPER es obligatorio/.test(m)));
        const igual = nuevo();
        assert.ok(evaluarEnv(prod({ JWT_SECRET: igual, PIN_PEPPER: igual })).some((m) => /JWT_SECRET y PIN_PEPPER deben ser distintos/.test(m)));
        const igual2 = nuevo(24);
        assert.ok(evaluarEnv(prod({ SETUP_TOKEN: igual2, PIN_PEPPER: igual2 })).some((m) => /PIN_PEPPER y SETUP_TOKEN deben ser distintos/.test(m)));
    });

    it("cualquier NODE_ENV que no sea development/test (incluido ausente o «staging») se trata como producción", () => {
        for (const NODE_ENV of [undefined, "", "staging", "production"]) {
            assert.ok(problemasDeSecretos(prod({ NODE_ENV, JWT_SECRET: SECRETOS_CONOCIDOS[0] })).length > 0, `NODE_ENV=${NODE_ENV}`);
        }
    });

    it("los mensajes NUNCA incluyen el valor de un secreto", () => {
        const malo = "cambia-esto-" + nuevo(24);
        const repetido = "z".repeat(40);
        const todo = evaluarEnv(prod({ JWT_SECRET: malo, SETUP_TOKEN: repetido, PIN_PEPPER: repetido })).join("\n");
        assert.ok(todo.length > 0);
        for (const v of [malo, repetido, "zzzz"]) assert.ok(!todo.includes(v), `el mensaje contiene el valor «${v.slice(0, 8)}…»`);
    });
});

describe("validación de la configuración: desarrollo", () => {
    it("desarrollo no exige PIN_PEPPER ni rechaza valores de ejemplo, pero sí el largo mínimo del JWT", () => {
        const dev = { NODE_ENV: "development", DATABASE_URL: "postgres://x@localhost/x", JWT_SECRET: "test_secret_de_al_menos_32_caracteres_ok" };
        assert.deepEqual(evaluarEnv(dev), []);
        assert.ok(evaluarEnv({ ...dev, JWT_SECRET: "corto" }).some((m) => /al menos 32/.test(m)));
    });
});

describe("arranque real del servidor con configuración insegura", () => {
    const servidor = resolve("server.js");
    const arrancar = (env) => {
        const dir = mkdtempSync(join(tmpdir(), "env-")); // sin .env: la prueba no depende del .env real
        try {
            return spawnSync(process.execPath, [servidor], { cwd: dir, encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH, ...env } });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };

    it("NODE_ENV=production con el secreto de .env.example NO arranca (código 1), nombra la regla y no imprime el valor", () => {
        const secreto = SECRETOS_CONOCIDOS[0];
        const r = arrancar({ NODE_ENV: "production", DATABASE_URL: "postgres://app@127.0.0.1:1/x", CORS_ORIGINS: "https://app.ejemplo.mx", JWT_SECRET: secreto, SETUP_TOKEN: nuevo(24), PIN_PEPPER: nuevo(), PORT: "0" });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /JWT_SECRET parece un valor de ejemplo/);
        assert.ok(!(r.stdout + r.stderr).includes(secreto));
    });

    it("sin PIN_PEPPER en producción tampoco arranca", () => {
        const r = arrancar({ NODE_ENV: "production", DATABASE_URL: "postgres://app@127.0.0.1:1/x", CORS_ORIGINS: "https://app.ejemplo.mx", JWT_SECRET: nuevo(), SETUP_TOKEN: nuevo(24), PORT: "0" });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /PIN_PEPPER es obligatorio/);
    });
});

describe("orden de arranque (arquitectura)", () => {
    // Los imports ESM se evalúan en orden: si la validación corriera después de importar app.js o la base, una configuración insegura
    // ya habría creado la app y abierto conexiones. No se puede observar de forma determinista desde fuera, así que se fija el orden.
    it("server.js carga .env y valida la configuración ANTES de importar la app, la base y el tiempo real", () => {
        const src = readFileSync(resolve("server.js"), "utf8");
        const pos = (t) => src.indexOf(t);
        assert.ok(pos('"dotenv/config"') >= 0 && pos('"./src/config/validar-env.js"') > pos('"dotenv/config"'), "dotenv antes que la validación");
        for (const modulo of ['"./src/app.js"', '"./src/config/db.js"', '"./src/realtime/eventosPos.js"']) {
            assert.ok(pos(modulo) > pos('"./src/config/validar-env.js"'), `${modulo} debe importarse después de la validación`);
        }
        assert.match(readFileSync(resolve("src/config/validar-env.js"), "utf8"), /^validateEnv\(\);$/m, "el módulo debe ejecutar validateEnv() al importarse");
    });
});
