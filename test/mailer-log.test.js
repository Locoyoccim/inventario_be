import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

// Camino real de un envío que falla: el log no debe llevar la dirección del destinatario en claro. Se usa un SMTP inexistente
// (conexión rechazada al instante). Va en su propio archivo porque el transporte del mailer se elige una sola vez por proceso.
process.env.NODE_ENV = "development";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
delete process.env.SMTP_URL;

describe("correo que no sale", () => {
    afterEach(() => mock.restoreAll());

    it("devuelve enviado:false y el log no trae el correo del destinatario", async () => {
        const salida = [];
        mock.method(console, "log", (l) => salida.push(String(l)));
        mock.method(console, "error", (l) => salida.push(String(l)));
        const { enviarCorreo } = await import("../src/utils/mailer.js");
        const r = await enviarCorreo({
            to: "ana.dueña@restaurante.mx",
            subject: "x",
            text: "x",
        });
        assert.equal(r.enviado, false);
        const log = salida.join("\n");
        assert.match(log, /No se pudo enviar el correo/);
        assert.equal(log.includes("ana.dueña@restaurante.mx"), false, log);
        assert.equal(log.includes("dueña@"), false, log);
        assert.match(log, /a\*\*\*@restaurante\.mx/);
    });
});
