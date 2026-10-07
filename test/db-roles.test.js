import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { construirSentencias, ident, SQL_DIAGNOSTICO } from "../scripts/db_roles.js";

const escapeLiteral = (s) => new pg.Client().escapeLiteral(s);
const base = { app: "gh_app", migrador: "gh_migrador", base: "inventarios", passwordApp: "pw-app", passwordMigrador: "pw-mig", escapeLiteral };
const sqls = (opts) => construirSentencias({ ...base, ...opts }).map((s) => s.sql);
const todo = (opts) => sqls(opts).join("\n");

describe("db:roles — sentencias de provisión (función pura)", () => {
    it("crea ambos roles sin superusuario, sin crear bases/roles y sin saltarse RLS", () => {
        const creates = sqls({}).filter((s) => s.startsWith("CREATE ROLE"));
        assert.equal(creates.length, 2);
        for (const c of creates) assert.match(c, /LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
    });

    it("si los roles ya existen no los crea, pero vuelve a fijar sus atributos (nunca con privilegios de más)", () => {
        const s = sqls({ existentes: { gh_app: true, gh_migrador: true }, passwordApp: undefined, passwordMigrador: undefined });
        assert.ok(!s.some((x) => x.startsWith("CREATE ROLE")));
        assert.equal(s.filter((x) => /^ALTER ROLE .* NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS$/.test(x)).length, 2);
        assert.ok(!s.some((x) => /PASSWORD/.test(x)), "sin contraseña en el entorno no se toca la contraseña");
    });

    it("con rol existente y contraseña en el entorno, la restablece", () => {
        const s = sqls({ existentes: { gh_app: true, gh_migrador: true } });
        assert.equal(s.filter((x) => /^ALTER ROLE .* PASSWORD /.test(x)).length, 2);
    });

    it("crear un rol sin contraseña es un error (no se crea un rol sin clave)", () => {
        assert.throws(() => construirSentencias({ ...base, passwordApp: undefined }), /Falta la contraseña de gh_app/);
    });

    it("todo lo que se otorga a la app está en una lista blanca: datos (SELECT/INSERT/UPDATE/DELETE), secuencias y conexión; nunca TRUNCATE, REFERENCES, TRIGGER, CREATE ni ALL", () => {
        const PERMITIDOS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "USAGE", "CONNECT"]);
        const grants = sqls({}).flatMap((x) => x.split(";")).map((x) => x.trim()).filter((x) => /\bGRANT\b/.test(x) && /TO "gh_app"/.test(x));
        assert.ok(grants.length >= 5, "debe haber permisos para la app");
        for (const g of grants) {
            const privs = /GRANT (.+?) ON /.exec(g)[1].split(",").map((p) => p.trim());
            for (const p of privs) assert.ok(PERMITIDOS.has(p), `privilegio no permitido para la app: «${p}» en: ${g}`);
        }
        const t = todo({});
        assert.match(t, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "gh_app"/);
        assert.match(t, /GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "gh_app"/);
        assert.match(t, /GRANT USAGE ON SCHEMA public TO "gh_app"/);
        assert.ok(!/GRANT USAGE, CREATE ON SCHEMA public TO "gh_app"/.test(t), "la app no crea objetos en el esquema");
    });

    it("deja permisos por defecto para lo que cree el migrador (tablas y secuencias futuras) y quita CREATE a PUBLIC", () => {
        const t = todo({});
        assert.match(t, /ALTER DEFAULT PRIVILEGES FOR ROLE "gh_migrador" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "gh_app"/);
        assert.match(t, /ALTER DEFAULT PRIVILEGES FOR ROLE "gh_migrador" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "gh_app"/);
        assert.match(t, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
        assert.match(t, /GRANT USAGE, CREATE ON SCHEMA public TO "gh_migrador"/);
    });

    it("nunca usa REASSIGN OWNED, ni otorga a PUBLIC, ni hace superusuario a nadie", () => {
        for (const adoptar of [false, true]) {
            const t = todo({ adoptar });
            assert.doesNotMatch(t, /REASSIGN OWNED/i);
            assert.doesNotMatch(t, /\bTO PUBLIC\b/i);
            assert.doesNotMatch(t, /\bSUPERUSER\b(?<!NOSUPERUSER)/);
        }
    });

    it("--adoptar añade el cambio de propietario objeto por objeto; sin él no hay ALTER ... OWNER", () => {
        assert.doesNotMatch(todo({ adoptar: false }), /OWNER TO/);
        const t = todo({ adoptar: true });
        assert.match(t, /ALTER %s %s OWNER TO %I/);
        assert.match(t, /ALTER FUNCTION %s OWNER TO %I/);
        assert.match(t, /n\.nspname = 'public'/, "solo el esquema public");
        // Regresión del ensayo: PostgreSQL rechaza cambiar el dueño de una secuencia vinculada a una columna (serial); se omite.
        assert.match(t, /NOT \(c\.relkind = 'S' AND EXISTS \(SELECT 1 FROM pg_depend d WHERE .*d\.deptype IN \('a','i'\)/s);
        assert.match(t, /ORDER BY \(c\.relkind = 'S'\)/, "las tablas primero, las secuencias sueltas después");
    });

    it("--sin-crear-roles no toca roles", () => {
        const s = sqls({ crearRoles: false });
        assert.ok(!s.some((x) => /ROLE/.test(x.replace(/FOR ROLE/g, ""))));
        assert.ok(s.some((x) => x.startsWith("GRANT CONNECT")));
    });

    it("rechaza nombres de rol o de base que no sean identificadores simples (sin inyección)", () => {
        for (const malo of ['gh_app"; DROP TABLE usuarios; --', "Gh_App", "gh-app", "", "a".repeat(64), "gh app"]) {
            assert.throws(() => ident(malo), /inválido/, malo);
            assert.throws(() => construirSentencias({ ...base, app: malo }), /inválido/);
            assert.throws(() => construirSentencias({ ...base, base: malo }), /inválido/);
        }
        assert.equal(ident("inventarios_test"), '"inventarios_test"');
    });

    it("las contraseñas con comillas o barras se escapan como literal y no rompen la sentencia", () => {
        const raro = `p'w"\\;--x`; // contiene comilla simple, comilla doble y una barra invertida real
        const s = sqls({ passwordApp: raro }).find((x) => x.startsWith('CREATE ROLE "gh_app"'));
        assert.ok(s.includes(escapeLiteral(raro)));
        assert.ok(!s.includes(` PASSWORD ${raro}`), "no debe ir sin escapar");
    });

    it("app y migrador deben ser roles distintos", () => {
        assert.throws(() => construirSentencias({ ...base, migrador: "gh_app" }), /distintos/);
    });

    it("el diagnóstico exige los CUATRO privilegios (has_table_privilege con lista cuenta si tiene alguno)", () => {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.match(SQL_DIAGNOSTICO, new RegExp(`has_table_privilege\\(\\$2, c\\.oid, '${p}'\\)`));
        assert.doesNotMatch(SQL_DIAGNOSTICO, /'SELECT, INSERT/);
    });
});
