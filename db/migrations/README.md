# Migraciones

Runner: `db/migrate.js`. Tabla de control: `schema_migrations`.

Los archivos se aplican en orden alfabético (`001_...`, `002_...`), cada uno en su transacción.
Solo se ejecutan los que no estén registrados en `schema_migrations`.

## Comandos
- `npm run migrate` — aplica las migraciones pendientes.
- `npm run migrate:status` — muestra cuáles están aplicadas ([x]) y cuáles no ([ ]).
- `npm run migrate:mark 001_baseline.sql` — marca una migración como aplicada SIN ejecutarla
  (para el baseline en una base que ya tiene el esquema).

## Conexión
Usa `DATABASE_URL` si está definida (Railway), o las variables `DB_*` del `.env` (local).
Para Postgres público de Railway, define `DB_SSL=require`.

## Flujo con base existente (local) + base nueva (Railway)
1. Genera el baseline desde tu base actual (esquema completo, sin datos):
   `pg_dump --schema-only --no-owner --no-privileges "<tu_connection_string_local>" > db/migrations/001_baseline.sql`
2. Local (ya tiene las tablas): `npm run migrate:mark 001_baseline.sql`
3. Railway (base vacía): con `DATABASE_URL` y `DB_SSL=require`, corre `npm run migrate` → crea todo.
4. Cambios futuros: nuevo archivo `002_descripcion.sql` y `npm run migrate` en cada entorno.
