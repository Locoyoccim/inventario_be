import test from "node:test";
import assert from "node:assert/strict";
import { parseFiltrosKardex } from "../src/modules/movimientos/movimiento.logic.js";
import UsuarioService from "../src/modules/usuarios/usuario.service.js";
import { estaActivo, invalidarUsuarioActivo } from "../src/middlewares/activeUser.js";

test("kardex: normaliza filtros validos", () => {
    const f = parseFiltrosKardex({ producto_id: "7", tipo: "compra", desde: "2026-09-01", hasta: "2026-09-30", sentido: "Entrada" });
    assert.deepEqual(f, { productoId: 7, tipo: "COMPRA", desde: "2026-09-01", hasta: "2026-09-30", sentido: "entrada" });
});

test("kardex: ignora filtros invalidos", () => {
    const f = parseFiltrosKardex({ producto_id: "abc", tipo: "ROBO", desde: "01/09/2026", sentido: "x" });
    assert.deepEqual(f, { productoId: null, tipo: null, desde: null, hasta: null, sentido: null });
});

function servicio(usuarios) {
    const repo = {
        findById: async (_e, id) => usuarios.find((u) => u.id === Number(id)),
        update: async (_e, id, data) => ({ id: Number(id), ...data }),
    };
    return new UsuarioService(repo, {});
}

test("usuarios: nadie se desactiva a si mismo", async () => {
    const s = servicio([{ id: 1, is_owner: false }]);
    await assert.rejects(s.updateUsuario(4, 1, { nombre: "A", codigo_ingreso: "A", activo: false }, { id: 1 }), /ti mismo/);
});

test("usuarios: el dueno no pierde Admin", async () => {
    const s = servicio([{ id: 1, is_owner: true }]);
    await assert.rejects(s.updateUsuario(4, 1, { nombre: "A", codigo_ingreso: "A", is_admin: false }, { id: 2 }), /dueño/);
});

test("usuarios: desactivar a otro se permite y la contrasena se hashea", async () => {
    const s = servicio([{ id: 3, is_owner: false }]);
    const r = await s.updateUsuario(4, 3, { nombre: "B", codigo_ingreso: "B", activo: false, password: "nueva123" }, { id: 1 });
    assert.equal(r.activo, false);
    assert.equal(r.password, undefined);
    assert.match(r.password_hash, /^\$2[aby]\$/);
});

test("usuarios: inexistente devuelve null", async () => {
    const s = servicio([]);
    assert.equal(await s.updateUsuario(4, 9, { nombre: "x", codigo_ingreso: "x" }, { id: 1 }), null);
});

test("usuario activo: cachea y se invalida", async () => {
    let consultas = 0;
    let activo = true;
    const query = async () => { consultas++; return { rows: [{ activo }] }; };
    assert.equal(await estaActivo(50, query), true);
    activo = false;
    assert.equal(await estaActivo(50, query), true, "dentro del TTL usa cache");
    invalidarUsuarioActivo(50);
    assert.equal(await estaActivo(50, query), false);
    assert.equal(consultas, 2);
    const vacio = async () => ({ rows: [] });
    invalidarUsuarioActivo(51);
    assert.equal(await estaActivo(51, vacio), false, "usuario borrado");
});
