# Roles de la base de datos (ADR-006 · VCA-015)

Estado: **vigente desde la Fase 3 (2026-10-07)**. Decisión: ADR-006 (registro de decisiones del proyecto). Fuente de verdad: `scripts/db_roles.js`, `src/config/rolDb.js`, `db/migrate.js`. Si este documento y el código discrepan, gana el código.

## 1. Por qué

La app se conectaba como `postgres` (superusuario). Un fallo de inyección SQL equivalía a ejecutar comandos en el servidor de la base (`COPY … PROGRAM`), leer sus archivos, apagar los triggers de integridad (`session_replication_role`) y, a futuro, saltarse cualquier RLS. Con el rol propuesto, todo eso queda denegado (probado en `test/integration/rol-aplicacion.test.js`).

## 2. Los roles

| Rol | Para qué | Puede | No puede |
|---|---|---|---|
| **`gh_app`** | La app en ejecución (`DATABASE_URL` o `DB_*`) y los respaldos (solo leen) | `SELECT/INSERT/UPDATE/DELETE` en las tablas de `public`; `USAGE/SELECT` en secuencias; `LISTEN/NOTIFY` | `DROP/ALTER/TRUNCATE`, crear objetos, `CREATE EXTENSION/ROLE/DATABASE`, `COPY … PROGRAM`, `pg_read_file`, apagar triggers, ser superusuario ni saltarse RLS |
| **`gh_migrador`** | Dueño de todos los objetos; corre las migraciones (`MIGRATE_DATABASE_URL`) y los fixtures de prueba con DDL | Crear/alterar objetos en `public` | Ser superusuario, crear bases o roles |
| **Administrador** (p. ej. `postgres`) | Solo provisionar roles (`npm run db:roles`) y crear bases (restaurar/verificar respaldos) | Todo | — (no lo usa la app ni se guarda en el `.env`) |

Los nombres son configurables (`--app`, `--migrador`). Contraseñas aleatorias, fuera del repositorio.

## 3. Variables

| Variable | Quién la usa | Contenido |
|---|---|---|
| `DATABASE_URL` (o `DB_*`) | la app, `npm run backup`, `crear_admin` | rol **`gh_app`** |
| `MIGRATE_DATABASE_URL` | `npm run migrate` (y `migrate:status/mark`) | rol **`gh_migrador`**. Sin ella, `migrate` usa la conexión de la app y falla por permisos si ese rol no es dueño (con una pista) |
| `ADMIN_DATABASE_URL` | `npm run db:roles`, `backup:verify`, `backup:restore` | administrador. **No se guarda en `.env`**: pásala por entorno (o usa `~/.pgpass` y omite la clave en la URL) |
| `GH_APP_PASSWORD`, `GH_MIGRADOR_PASSWORD` | `npm run db:roles` | contraseñas de los roles (obligatorias al crearlos) |
| `TEST_DATABASE_URL` / `TEST_MIGRATOR_URL` | pruebas | `gh_app` / `gh_migrador` sobre la base de **pruebas** (`.env.test`, `npm run test:local`) |
| `PERMITIR_DB_SUPERUSUARIO=1` | arranque | **Escape de emergencia** (ver §6). No lo dejes puesto |

## 4. Provisionar una base (local, CI o producción)

```bash
# 1) Base nueva (aún sin tablas): crea roles y permisos
ADMIN_DATABASE_URL=postgres://admin:CLAVE@host:5432/inventarios \
GH_APP_PASSWORD="$(openssl rand -hex 24)" GH_MIGRADOR_PASSWORD="$(openssl rand -hex 24)" \
npm run db:roles
#   (guarda esas contraseñas donde guardes secretos; no se imprimen)

# 2) Migrar COMO migrador
MIGRATE_DATABASE_URL=postgres://gh_migrador:CLAVE@host:5432/inventarios npm run migrate

# 3) La app arranca con DATABASE_URL=postgres://gh_app:CLAVE@host:5432/inventarios
```

- **Base que ya tenía tablas** (creadas por un superusuario): añade `--adoptar` al paso 1; pasa al migrador la propiedad de tablas, secuencias, vistas y funciones de `public`, **objeto por objeto** (nunca `REASSIGN OWNED`, que arrastraría también otras bases del clúster). Es una operación de metadatos; haz `npm run backup` antes.
- **Idempotente:** se puede repetir. Si el rol ya existe, solo se reafirman sus atributos; la contraseña se cambia únicamente si defines la variable.
- **Base restaurada** de un respaldo: queda a nombre del administrador. Antes de apuntar la app: `ADMIN_DATABASE_URL=… npm run db:roles -- --base <nueva> --adoptar`.
- Bases gestionadas donde los roles ya existen: `--sin-crear-roles`.

## 5. Migraciones nuevas

Las corre `gh_migrador`, así que **los objetos nuevos nacen suyos** y `gh_app` recibe lectura/escritura automáticamente (`ALTER DEFAULT PRIVILEGES`, que `db:roles` deja configurado). Reglas:
- Nunca ejecutar una migración como administrador ni como `gh_app`: el objeto nacería con otro dueño y la app perdería acceso. La prueba de deriva (`rol-aplicacion.test.js`) falla en CI si ocurre.
- Los *default privileges* son **por base y por rol creador**: una base nueva o restaurada necesita volver a correr `db:roles`.
- Una migración que necesite algo más que DML para la app (p. ej. una función `SECURITY DEFINER`, `TRUNCATE`) es una decisión explícita: documéntala en el ADR.

## 6. Guardia de arranque

Al iniciar, la app consulta su propio rol (`src/config/rolDb.js`). **En producción** (cualquier `NODE_ENV` distinto de `development`/`test`) **aborta** si el rol es superusuario, tiene `BYPASSRLS`/`CREATEROLE`/`CREATEDB` o es dueño de tablas. **En desarrollo** solo avisa. Si la base no responde al arrancar, no aborta (no es un hallazgo de seguridad).

`PERMITIR_DB_SUPERUSUARIO=1` deja arrancar con un aviso fuerte. Es un recurso de emergencia (p. ej. un proveedor que solo ofrece superusuario mientras se resuelve); retíralo en cuanto se pueda.

## 7. Puesta en producción (Railway u otro)

1. Crear la base. **Verificar** con qué usuario administrador entrega el proveedor y si puede `CREATE ROLE` — *no verificado hasta el despliegue*. Si no puede, pedir los roles al proveedor y usar `--sin-crear-roles`.
2. Ejecutar el paso 1 de §4 con `ADMIN_DATABASE_URL` (desde un equipo de confianza, no desde la app).
3. Variables del servicio: `DATABASE_URL` = `gh_app`; `MIGRATE_DATABASE_URL` = `gh_migrador`; `PIN_PEPPER`, `JWT_SECRET`, `SETUP_TOKEN` nuevos (ver `AUTH_STRATEGY.md`); sin `PERMITIR_DB_SUPERUSUARIO`.
4. El comando de migración del despliegue (`npm run migrate`) toma `MIGRATE_DATABASE_URL`. *Cómo se ejecuta antes de cada despliegue en Railway: por verificar.*
   **Límite a tener presente:** si las migraciones corren como *pre-deploy* del **mismo servicio**, la URL del migrador queda también en el entorno de ejecución de la app. Una inyección SQL sigue neutralizada (la *conexión* de la app es de privilegios mínimos), pero quien lograra leer el entorno completo del proceso obtendría la credencial del dueño de las tablas. Lo más sólido es migrar desde un job/servicio aparte (o desde CI) que sea el único con esa variable. No es obligatorio para lanzar; es una mejora posterior.
5. Comprobar en el primer arranque: sin «AVISO» ni «Configuración insegura» en los logs.
6. Respaldos: `npm run backup` funciona con `gh_app`. `backup:verify`/`backup:restore` necesitan `ADMIN_DATABASE_URL`.

## 8. Qué NO cubre

- `gh_app` conserva `DELETE`/`UPDATE` sobre todas las tablas, incluido el kardex (`movimientosinventario`). Volverlo solo-inserción (o con borrado lógico) es una decisión de producto aparte.
- No es RLS: el aislamiento entre empresas sigue dependiendo de la aplicación (ADR-001). Este cambio es el prerrequisito: con un rol que no es dueño ni superusuario, `FORCE ROW LEVEL SECURITY` pasa a tener efecto.
- No limita conexiones por rol (la suite abre decenas en paralelo).
