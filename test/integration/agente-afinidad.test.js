import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Afinidad impresora → agente: con varias PCs en la empresa, cada agente solo reclama trabajos de sus impresoras.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integración HTTP — afinidad impresora/agente", { skip: SKIP }, () => {
    const A = 9791;
    const B = 9792;
    let server, base, pool, signToken, tokAdmin, caja, barra, ajeno, impCaja, impBarra, impLibre;

    const req = async (method, path, { token, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try {
            json = await res.json();
        } catch {
            /* vacío */
        }
        return { status: res.status, json };
    };
    const mkAgente = async (empresa, nombre) => {
        const id = (
            await pool.query(
                "INSERT INTO agentes_impresion (empresa_id, nombre, token_hash) VALUES ($1,$2,$3) RETURNING id",
                [empresa, nombre, `${nombre}-${empresa}`.padEnd(64, "0")],
            )
        ).rows[0].id;
        return id;
    };
    const limpiar = async () => {
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM agentes_impresion WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = ANY($1)", [[A, B]]);
        await pool.query("DELETE FROM empresas WHERE id = ANY($1)", [[A, B]]);
    };
    const mkImpresora = async (nombre, agente_id) =>
        (
            await pool.query(
                "INSERT INTO impresoras (empresa_id,nombre,conexion,ip,es_ticket,agente_id) VALUES ($1,$2,'RED','10.0.0.9',true,$3) RETURNING id",
                [A, nombre, agente_id],
            )
        ).rows[0].id;
    const trabajo = async (impresora_id) =>
        (
            await pool.query(
                "INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, estado, payload) VALUES ($1,'PRUEBA',$2,$2,'PENDIENTE','{}') RETURNING id",
                [A, impresora_id],
            )
        ).rows[0].id;
    const reclamar = async (agente_id) => {
        const { default: PosImpresionRepository } =
            await import("../../src/modules/pos/pos.impresion.repository.js");
        return (await new PosImpresionRepository().reclamarPendientes(A, agente_id))
            .map((j) => j.id)
            .sort((a, b) => a - b);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Dos PCs'), ($2,'Otra')", [
            A,
            B,
        ]);
        const uid = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('AF-adm','AF-adm',true,true,$1) RETURNING id",
                [A],
            )
        ).rows[0].id;
        tokAdmin = await signToken({
            id: uid,
            empresa_id: A,
            is_admin: true,
            is_owner: true,
            tv: 0,
        });
        caja = await mkAgente(A, "Caja");
        barra = await mkAgente(A, "Barra");
        ajeno = await mkAgente(B, "Ajeno");
        impCaja = await mkImpresora("Tickets", caja);
        impBarra = await mkImpresora("Barra", barra);
        impLibre = await mkImpresora("Sin asignar", null);
    });

    after(async () => {
        await limpiar();
        await pool.end();
        await new Promise((r) => server.close(r));
    });

    it("cada agente reclama solo los trabajos de sus impresoras y los de impresoras sin asignar", async () => {
        const tCaja = await trabajo(impCaja);
        const tBarra = await trabajo(impBarra);
        const tLibre = await trabajo(impLibre);
        assert.deepEqual(await reclamar(caja), [tCaja, tLibre]);
        assert.deepEqual(
            await reclamar(barra),
            [tBarra],
            "lo de Caja ya está tomado y lo suyo sigue pendiente",
        );
    });

    it("las impresoras sin agente asignado siguen sirviendo a cualquiera (compatibilidad)", async () => {
        const t = await trabajo(impLibre);
        assert.deepEqual(await reclamar(barra), [t]);
    });

    it("crear y editar una impresora valida que el agente sea de la empresa", async () => {
        const base_ = { nombre: "Nueva", conexion: "RED", ip: "10.0.0.20", es_ticket: true };
        const mala = await req("POST", `/api/pos/${A}/impresoras`, {
            token: tokAdmin,
            body: { ...base_, agente_id: ajeno },
        });
        assert.equal(mala.status, 400, JSON.stringify(mala.json));
        const ok = await req("POST", `/api/pos/${A}/impresoras`, {
            token: tokAdmin,
            body: { ...base_, agente_id: barra },
        });
        assert.equal(ok.status, 201, JSON.stringify(ok.json));
        assert.equal(ok.json.data.agente_id, barra);
        const edit = await req("PUT", `/api/pos/${A}/impresoras/${ok.json.data.id}`, {
            token: tokAdmin,
            body: { agente_id: null },
        });
        assert.equal(edit.status, 200, JSON.stringify(edit.json));
        assert.equal(edit.json.data.agente_id, null);
        assert.equal(
            (
                await req("PUT", `/api/pos/${A}/impresoras/${ok.json.data.id}`, {
                    token: tokAdmin,
                    body: { agente_id: ajeno },
                })
            ).status,
            400,
        );
    });
});
