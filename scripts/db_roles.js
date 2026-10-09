#!/usr/bin/env node
// Provisiona los roles de la base: un MIGRADOR (dueño de los objetos; corre las migraciones) y una APP (solo lee/escribe datos).
// Es idempotente y NO usa REASSIGN OWNED (afectaría a todo lo que posea el rol, bases incluidas): cambia el dueño objeto por objeto.
//
//   ADMIN_DATABASE_URL=postgres://admin:clave@host:5432/inventarios \
//   GH_APP_PASSWORD=... GH_MIGRADOR_PASSWORD=... npm run db:roles -- [--adoptar] [--base otra_base]
//
// Opciones:
//   --adoptar            pasa al migrador la propiedad de las tablas/secuencias/vistas/funciones existentes de «public»
//                        (necesario una vez en una base creada antes de tener roles). Una base nueva no lo necesita.
//   --base <nombre>      aplica a otra base del mismo servidor (p. ej. una restaurada), en vez de la de la URL.
//   --app <rol> / --migrador <rol>   nombres de los roles (por defecto gh_app y gh_migrador).
//   --sin-crear-roles    no crea ni altera roles (bases gestionadas donde ya existen); solo aplica permisos.
//
// Contraseñas: GH_APP_PASSWORD / GH_MIGRADOR_PASSWORD son OBLIGATORIAS al crear un rol; si el rol ya existe, definirlas la
// restablece. Nunca se imprimen ni quedan en el repositorio. El administrador necesita CREATEROLE (o ser superusuario).
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Identificador entre comillas, solo si es seguro (minúsculas, números y guion bajo). Lanza si no. */
export function ident(nombre) {
    if (!IDENT.test(nombre))
        throw new Error(
            `Nombre de rol o base inválido: «${nombre}» (usa minúsculas, números y guion bajo).`,
        );
    return `"${nombre}"`;
}

/**
 * Sentencias que dejan la base con el esquema de permisos correcto. Función pura: no se conecta ni lee el entorno.
 * Cada elemento: { paso, sql }. `sql` puede contener una contraseña (CREATE/ALTER ROLE): nunca se imprime, solo `paso`.
 */
export function construirSentencias({
    app,
    migrador,
    base,
    passwordApp,
    passwordMigrador,
    existentes = {},
    adoptar = false,
    crearRoles = true,
    escapeLiteral,
}) {
    const A = ident(app),
        M = ident(migrador),
        B = ident(base);
    if (app === migrador)
        throw new Error("El rol de la app y el del migrador deben ser distintos.");
    const out = [];
    const atributos = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS";

    if (crearRoles) {
        for (const [nombre, id, password] of [
            [app, A, passwordApp],
            [migrador, M, passwordMigrador],
        ]) {
            if (!existentes[nombre]) {
                if (!password)
                    throw new Error(
                        `Falta la contraseña de ${nombre} (variable de entorno) para crear el rol.`,
                    );
                out.push({
                    paso: `crear el rol ${nombre}`,
                    sql: `CREATE ROLE ${id} ${atributos} PASSWORD ${escapeLiteral(password)}`,
                });
            } else {
                // Aunque ya exista, se garantiza que no tenga privilegios de más.
                out.push({
                    paso: `fijar los atributos de ${nombre} (sin superusuario)`,
                    sql: `ALTER ROLE ${id} ${atributos}`,
                });
                if (password)
                    out.push({
                        paso: `restablecer la contraseña de ${nombre}`,
                        sql: `ALTER ROLE ${id} PASSWORD ${escapeLiteral(password)}`,
                    });
            }
        }
    }

    out.push({
        paso: "permitir conectar a la base",
        sql: `GRANT CONNECT ON DATABASE ${B} TO ${A}, ${M}`,
    });
    out.push({
        paso: "quitar CREATE en el esquema public a todos (PostgreSQL ≤ 14 lo permite por defecto)",
        sql: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    });
    out.push({
        paso: "esquema public: la app solo usa; el migrador también crea",
        sql: `GRANT USAGE ON SCHEMA public TO ${A}; GRANT USAGE, CREATE ON SCHEMA public TO ${M}`,
    });

    if (adoptar) {
        out.push({
            paso: "adoptar: pasar al migrador la propiedad de los objetos existentes de public",
            sql: `DO $adoptar$
DECLARE r record;
BEGIN
  -- Las secuencias vinculadas a una columna (serial) NO se pueden cambiar solas ("Sequence is linked to table"): cambian con su tabla.
  FOR r IN SELECT c.oid::regclass AS nombre, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m') AND pg_get_userbyid(c.relowner) <> ${escapeLiteral(migrador)}
             AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                                                    AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')))
           ORDER BY (c.relkind = 'S') LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.nombre, ${escapeLiteral(migrador)});
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS nombre FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_userbyid(p.proowner) <> ${escapeLiteral(migrador)} LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.nombre, ${escapeLiteral(migrador)});
  END LOOP;
END
$adoptar$`,
        });
    }

    // Permisos sobre lo que ya existe y, sobre todo, sobre lo que el migrador cree en el futuro (cada migración nueva).
    out.push({
        paso: "app: leer y escribir datos de las tablas existentes (nada de DDL, TRUNCATE ni REFERENCES)",
        sql: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${A}`,
    });
    out.push({
        paso: "app: usar las secuencias existentes",
        sql: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${A}`,
    });
    out.push({
        paso: "permisos por defecto: tablas que cree el migrador",
        sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${M} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${A}`,
    });
    out.push({
        paso: "permisos por defecto: secuencias que cree el migrador",
        sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${M} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${A}`,
    });
    return out;
}

/** Estado que se muestra al terminar (sin secretos): objetos sin migrador como dueño o tablas sin permisos para la app. */
export const SQL_DIAGNOSTICO = `
SELECT
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ) AS tablas,
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m') AND pg_get_userbyid(c.relowner) <> $1) AS objetos_de_otro_dueno,
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       -- has_table_privilege con varios privilegios en una lista es verdadero si tiene ALGUNO: se exigen los cuatro.
       AND NOT (has_table_privilege($2, c.oid, 'SELECT') AND has_table_privilege($2, c.oid, 'INSERT')
                AND has_table_privilege($2, c.oid, 'UPDATE') AND has_table_privilege($2, c.oid, 'DELETE'))) AS tablas_sin_permiso_para_app`;

function argumento(args, nombre) {
    const i = args.indexOf(nombre);
    return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
    dotenv.config({ quiet: true });
    const args = process.argv.slice(2);
    const app = argumento(args, "--app") ?? "gh_app";
    const migrador = argumento(args, "--migrador") ?? "gh_migrador";
    const url = process.env.ADMIN_DATABASE_URL;
    if (!url) {
        console.error(
            "Falta ADMIN_DATABASE_URL (conexión de un administrador con CREATEROLE, a la base que se va a provisionar).",
        );
        process.exit(1);
    }
    const u = new URL(url);
    const baseArg = argumento(args, "--base");
    if (baseArg) u.pathname = `/${baseArg}`;
    const base = decodeURIComponent(u.pathname.replace(/^\//, ""));

    const cliente = new pg.Client({
        connectionString: u.toString(),
        ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
    });
    await cliente.connect();
    try {
        const yo = (
            await cliente.query(
                "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
            )
        ).rows[0];
        const crearRoles = !args.includes("--sin-crear-roles");
        if (crearRoles && !yo.rolsuper && !yo.rolcreaterole)
            throw new Error(
                "El administrador necesita CREATEROLE (o ser superusuario) para crear roles. Si los roles ya existen, usa --sin-crear-roles.",
            );
        const existentes = {};
        for (const r of (
            await cliente.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [
                [app, migrador],
            ])
        ).rows)
            existentes[r.rolname] = true;

        const sentencias = construirSentencias({
            app,
            migrador,
            base,
            existentes,
            crearRoles,
            adoptar: args.includes("--adoptar"),
            passwordApp: process.env.GH_APP_PASSWORD,
            passwordMigrador: process.env.GH_MIGRADOR_PASSWORD,
            escapeLiteral: (s) => cliente.escapeLiteral(s),
        });
        await cliente.query("BEGIN");
        try {
            for (const { paso, sql } of sentencias) {
                await cliente.query(sql);
                console.log(`  ✔ ${paso}`);
            }
            await cliente.query("COMMIT");
        } catch (e) {
            await cliente.query("ROLLBACK");
            // Solo el mensaje del servidor: la sentencia puede llevar una contraseña y nunca se imprime.
            throw new Error(`No se aplicaron los cambios (se revirtieron): ${e.message}`, {
                cause: e,
            });
        }
        const d = (await cliente.query(SQL_DIAGNOSTICO, [migrador, app])).rows[0];
        console.log(
            `\nBase «${base}»: ${d.tablas} tablas · ${d.objetos_de_otro_dueno} objetos que no son del migrador · ${d.tablas_sin_permiso_para_app} tablas sin permisos para la app.`,
        );
        if (d.objetos_de_otro_dueno > 0)
            console.log(
                "Hay objetos con otro dueño: vuelve a correr con --adoptar (las migraciones nuevas fallarían por permisos).",
            );
        if (d.tablas_sin_permiso_para_app > 0) {
            console.error("Hay tablas a las que la app no puede acceder.");
            process.exitCode = 1;
        }
    } finally {
        await cliente.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(`\ndb:roles falló: ${e.message}`);
        process.exit(1);
    });
}
