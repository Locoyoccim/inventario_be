import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { iniciarServidor, HOST_PRUEBAS } from "./helpers/servidor.js";

const cerrar = (s) => new Promise((r) => s.close(r));
const app = () => createServer((_req, res) => res.end("ok"));

describe("helper de arranque del servidor de pruebas", () => {
    it("se enlaza a 127.0.0.1 (no al comodín) y responde en la base que devuelve", async () => {
        const { server, base } = await iniciarServidor(app());
        try {
            assert.equal(server.address().address, HOST_PRUEBAS);
            assert.equal(base, `http://127.0.0.1:${server.address().port}`);
            assert.equal(await (await fetch(base)).text(), "ok");
        } finally {
            await cerrar(server);
        }
    });

    it("un puerto ocupado en 127.0.0.1 falla con un error claro (EADDRINUSE), sin reintentar ni escuchar en otro lado", async () => {
        const ocupante = await iniciarServidor(app());
        try {
            const puerto = ocupante.server.address().port;
            await assert.rejects(
                iniciarServidor(app(), { puerto }),
                (e) => e.code === "EADDRINUSE" && e.message.includes(`el puerto ${puerto}`) && e.message.includes(HOST_PRUEBAS),
            );
        } finally {
            await cerrar(ocupante.server);
        }
    });

    it("dos servidores simultáneos reciben puertos distintos y cada fetch llega al suyo", async () => {
        const mk = (texto) => createServer((_req, res) => res.end(texto));
        const a = await iniciarServidor(mk("A"));
        const b = await iniciarServidor(mk("B"));
        try {
            assert.notEqual(a.base, b.base);
            assert.equal(await (await fetch(a.base)).text(), "A");
            assert.equal(await (await fetch(b.base)).text(), "B");
        } finally {
            await cerrar(a.server);
            await cerrar(b.server);
        }
    });
});
