import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
    crearVigilanteReadiness,
    conTimeout,
    manejadorReadiness,
    RECORDATORIO_MS,
    TIMEOUT_READINESS_MS,
} from "../src/utils/readiness.js";
import { iniciarServidor } from "./helpers/servidor.js";

// /health/ready: solo se registran las transiciones (cayó, sigue caída, se recuperó), no cada consulta. Sin base de datos.

function vigilante({ recordatorioMs = 1000 } = {}) {
    let t = 1_000_000;
    const lineas = [];
    const reg =
        (nivel) =>
        (mensaje, datos = {}) =>
            lineas.push({ nivel, mensaje, ...datos });
    const v = crearVigilanteReadiness({
        log: { info: reg("info"), warn: reg("warn"), error: reg("error") },
        ahora: () => t,
        recordatorioMs,
    });
    return { v, lineas, avanzar: (ms) => (t += ms) };
}

describe("vigilante de readiness", () => {
    it("mientras la base responde no escribe nada", () => {
        const { v, lineas } = vigilante();
        for (let i = 0; i < 20; i++) v.observar(true);
        assert.deepEqual(lineas, []);
    });

    it("la primera consulta que falla escribe UNA línea readiness_caida (error) con el motivo", () => {
        const { v, lineas } = vigilante();
        v.observar(false, new Error("connect ECONNREFUSED 127.0.0.1:5432"));
        assert.equal(lineas.length, 1);
        assert.equal(lineas[0].mensaje, "readiness_caida");
        assert.equal(lineas[0].nivel, "error");
        assert.match(lineas[0].error, /ECONNREFUSED/);
    });

    it("las consultas siguientes que fallan no escriben nada hasta el recordatorio", () => {
        const { v, lineas, avanzar } = vigilante({ recordatorioMs: 1000 });
        v.observar(false, new Error("x"));
        for (let i = 0; i < 30; i++) {
            avanzar(10);
            v.observar(false, new Error("x"));
        }
        assert.equal(lineas.length, 1, "solo readiness_caida");
    });

    it("cada `recordatorioMs` recuerda que sigue caída, con cuánto lleva y cuántos fallos", () => {
        const { v, lineas, avanzar } = vigilante({ recordatorioMs: 1000 });
        v.observar(false, new Error("x"));
        avanzar(1000);
        v.observar(false, new Error("x"));
        avanzar(999);
        v.observar(false, new Error("x")); // aún no toca
        avanzar(1);
        v.observar(false, new Error("x"));
        const r = lineas.filter((l) => l.mensaje === "readiness_sigue_caida");
        assert.equal(r.length, 2);
        assert.equal(r[0].caida_ms, 1000);
        assert.equal(r[1].caida_ms, 2000);
        assert.equal(r[1].fallos_consecutivos, 4);
        assert.equal(r[0].nivel, "error");
    });

    it("al volver, readiness_recuperada dice cuánto duró y cuántas consultas fallaron; una caída nueva vuelve a avisar", () => {
        const { v, lineas, avanzar } = vigilante();
        v.observar(false, new Error("a"));
        avanzar(250);
        v.observar(false, new Error("a"));
        avanzar(250);
        v.observar(true);
        const rec = lineas.find((l) => l.mensaje === "readiness_recuperada");
        assert.equal(rec.nivel, "info");
        assert.equal(rec.caida_ms, 500);
        assert.equal(rec.fallos_consecutivos, 2);
        v.observar(true); // ya estaba bien: nada más
        assert.equal(lineas.filter((l) => l.mensaje === "readiness_recuperada").length, 1);
        v.observar(false, new Error("b"));
        assert.equal(lineas.filter((l) => l.mensaje === "readiness_caida").length, 2);
        assert.deepEqual(v.estado().estado, "caido");
        // La cuenta de la caída nueva empieza de cero (no arrastra los 2 fallos de la anterior)
        avanzar(100);
        v.observar(true);
        const ultima = lineas.filter((l) => l.mensaje === "readiness_recuperada").at(-1);
        assert.equal(ultima.fallos_consecutivos, 1);
        assert.equal(ultima.caida_ms, 100);
    });

    it("el motivo se acota (un error enorme no llena el log) y un valor que no es Error no rompe", () => {
        const { v, lineas } = vigilante();
        v.observar(false, "x".repeat(5000));
        assert.equal(lineas[0].error.length, 300);
        const otra = vigilante();
        otra.v.observar(false, undefined);
        assert.equal(typeof otra.lineas[0].error, "string");
    });

    it("el vigilante real usa un recordatorio de 5 minutos", () => {
        assert.equal(RECORDATORIO_MS, 5 * 60 * 1000);
    });
});

describe("conTimeout", () => {
    afterEach(() => mock.restoreAll());

    it("deja pasar el resultado y el error de la promesa, y rechaza si tarda más del tope", async () => {
        assert.equal(await conTimeout(Promise.resolve(7), 1000), 7);
        await assert.rejects(conTimeout(Promise.reject(new Error("fallo")), 1000), /fallo/);
        await assert.rejects(conTimeout(new Promise(() => {}), 20), /no respondió en 20 ms/);
    });

    it("limpia su temporizador cuando la promesa ya respondió o falló (no deja el proceso colgado)", async () => {
        const espia = mock.method(globalThis, "clearTimeout");
        await conTimeout(Promise.resolve(1), 60_000);
        assert.equal(espia.mock.callCount(), 1, "tras responder");
        await conTimeout(Promise.reject(new Error("x")), 60_000).catch(() => {});
        assert.equal(espia.mock.callCount(), 2, "tras fallar");
        await conTimeout(new Promise(() => {}), 10).catch(() => {});
        assert.equal(espia.mock.callCount(), 3, "tras vencer el tope");
    });

    it("el tope por defecto de la comprobación es de 5 s", () => {
        assert.equal(TIMEOUT_READINESS_MS, 5000);
    });
});

describe("manejadorReadiness (ruta real de Express)", () => {
    async function servidor(opciones) {
        const app = express();
        app.get("/health/ready", manejadorReadiness(opciones));
        return await iniciarServidor(app);
    }
    const cerrar = (s) => new Promise((r) => s.close(r));

    it("responde 200 ready si la consulta funciona y 503 unavailable (sin detalle del error) si falla", async () => {
        let falla = false;
        const { v, lineas } = vigilante();
        const { server, base } = await servidor({
            consulta: async () => {
                if (falla)
                    throw new Error(
                        "detalle interno: password authentication failed for user gh_app",
                    );
            },
            vigilante: v,
        });
        try {
            const ok = await fetch(`${base}/health/ready`);
            assert.equal(ok.status, 200);
            assert.equal((await ok.json()).status, "ready");
            falla = true;
            const mal = await fetch(`${base}/health/ready`);
            assert.equal(mal.status, 503);
            const cuerpo = await mal.json();
            assert.deepEqual(cuerpo, { status: "unavailable" });
            assert.equal(lineas.filter((l) => l.mensaje === "readiness_caida").length, 1);
            falla = false;
            assert.equal((await fetch(`${base}/health/ready`)).status, 200);
            assert.equal(lineas.filter((l) => l.mensaje === "readiness_recuperada").length, 1);
        } finally {
            await cerrar(server);
        }
    });

    it("si la base se cuelga, responde 503 al cumplirse el tope en lugar de quedarse esperando", async () => {
        const { v, lineas } = vigilante();
        const { server, base } = await servidor({
            consulta: () => new Promise(() => {}),
            vigilante: v,
            timeoutMs: 80,
        });
        try {
            const t0 = Date.now();
            const r = await fetch(`${base}/health/ready`);
            assert.equal(r.status, 503);
            assert.ok(Date.now() - t0 < 2000);
            assert.match(lineas[0].error, /no respondió en 80 ms/);
        } finally {
            await cerrar(server);
        }
    });

    it("una consulta que lanza de forma síncrona también cuenta como caída", async () => {
        const { v, lineas } = vigilante();
        const { server, base } = await servidor({
            consulta: () => {
                throw new Error("falló de golpe");
            },
            vigilante: v,
        });
        try {
            assert.equal((await fetch(`${base}/health/ready`)).status, 503);
            assert.equal(lineas[0].mensaje, "readiness_caida");
        } finally {
            await cerrar(server);
        }
    });
});

describe("el log de readiness sale saneado", () => {
    afterEach(() => mock.restoreAll());

    it("con el logger real, credenciales de una URL y un correo en el error no llegan a la línea", () => {
        const salida = [];
        mock.method(console, "log", (l) => salida.push(l));
        mock.method(console, "error", (l) => salida.push(l));
        const v = crearVigilanteReadiness();
        v.observar(
            false,
            new Error(
                "no conecta a postgres://gh_app:claveSecreta@10.0.0.5/db para ana@correo.com",
            ),
        );
        const texto = salida.join("\n");
        assert.match(texto, /readiness_caida/);
        assert.equal(texto.includes("claveSecreta"), false);
        assert.equal(texto.includes("ana@correo.com"), false);
    });
});
