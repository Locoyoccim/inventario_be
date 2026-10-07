# Respaldos de la base de datos

La base (PostgreSQL) guarda todo el negocio de cada empresa: inventario, recetas, ventas del POS, cortes y finanzas.
Un respaldo es lo único que permite recuperarse de un borrado, una migración fallida o la caída del servidor.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run backup` | Crea `backups/<base>-AAAAMMDD-HHMMSS.dump` (formato comprimido de `pg_dump`), comprueba que se pueda leer y borra las más antiguas (se conservan 14). |
| `npm run backup:verify [archivo]` | **Prueba de recuperación**: restaura el respaldo (el último por defecto) en una base temporal, compara los conteos de las tablas clave con la base actual y borra la temporal. |
| `npm run backup:restore -- <archivo> <base_nueva>` | Restaura en una base **nueva**. Nunca sobrescribe la base en uso. |

Usan las mismas variables de conexión que el servidor (con el rol **`gh_app`**: **respaldar solo lee**, no necesita más). Para `backup:verify` y `backup:restore` (crean bases) hace falta un administrador: `ADMIN_DATABASE_URL` (ver [DB_ROLES.md](DB_ROLES.md)); una base restaurada necesita `npm run db:roles -- --base <base> --adoptar` antes de usarla con la app. Las variables de conexión son las del servidor (`DATABASE_URL` + `DB_SSL=require` en Railway, o `DB_*` en local) y
necesitan las herramientas cliente de PostgreSQL (`pg_dump`, `pg_restore`) en el equipo que las ejecute. La contraseña viaja
por `PGPASSWORD`, no por la línea de comandos. Los archivos se crean con permisos `600` y `backups/` está en `.gitignore`:
**contienen datos reales; no se suben a git ni se comparten.**

Variables opcionales: `BACKUP_DIR` (carpeta, por defecto `./backups`), `BACKUP_KEEP` (copias a conservar, por defecto 14) y
`BACKUP_UPLOAD_CMD` (ver abajo).

> `pg_dump` más nuevo que el servidor escribe algún `SET` que el servidor viejo no conoce (p. ej. `transaction_timeout` de
> PostgreSQL 17). El script lo tolera; cualquier otro error al restaurar lo detiene.

## Una copia en el mismo equipo no es un respaldo

Si el disco o el servidor se pierden, la copia se pierde con ellos. Hay que **sacar la copia de ahí**. `BACKUP_UPLOAD_CMD`
corre un comando justo después del respaldo; `{file}` es la ruta del archivo. Ejemplos:

```bash
# Backblaze B2 / S3 / Cloudflare R2 con rclone (configurado antes con `rclone config`)
BACKUP_UPLOAD_CMD='rclone copy {file} remoto:gastronomyhub-respaldos/'
# AWS S3
BACKUP_UPLOAD_CMD='aws s3 cp {file} s3://mi-bucket/respaldos/'
```

Usa un destino **privado**, con cifrado en reposo, y una cuenta con permiso de solo escritura si es posible.

## Programarlo

Un respaldo manual se olvida. Programa uno diario, en horario de poco uso (p. ej. 04:00 hora del negocio):

```cron
0 4 * * *  cd /ruta/a/inventario_BE && /usr/bin/env npm run backup >> backups/respaldo.log 2>&1
```

En macOS puede ser `launchd`; en Railway puede ser un servicio *cron* aparte que ejecute `npm run backup` con
`DATABASE_URL` y `BACKUP_UPLOAD_CMD` (la imagen necesita `postgresql-client`). Si el proveedor ofrece copias automáticas
del volumen de PostgreSQL (revisa la sección de *Backups* de tu servicio), actívalas **además** de esto, no en su lugar.

## Restaurar ante un desastre

1. Elige el respaldo más reciente que esté bien (`npm run backup:verify <archivo>` lo comprueba).
2. `npm run backup:restore -- backups/<archivo>.dump gastronomyhub_recuperada`
3. Revisa la base nueva (conteos, últimas ventas y cortes).
4. Apunta `DB_NAME` / `DATABASE_URL` a ella y reinicia el servidor. La base dañada se conserva hasta que estés seguro.
5. Ejecuta `npm run migrate:status` por si el respaldo es anterior a alguna migración.

Se pierde todo lo registrado después del respaldo: por eso conviene respaldar con frecuencia y **cada vez antes de
aplicar migraciones en producción** (`npm run backup && npm run migrate`).

## Rutina recomendada

- Diario: respaldo automático **fuera** del servidor.
- Antes de cada migración o despliegue con cambios de base: `npm run backup`.
- Cada mes: `npm run backup:verify` sobre un respaldo del destino externo, para saber que realmente se restaura.
