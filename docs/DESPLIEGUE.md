# Despliegue a producción (Railway) y lista de salida

Estado: **diseño aprobado el 2026-10-09 (ADR-012); aún sin desplegar.** Este documento es a la vez la receta y el checklist con evidencia
(cierra AUD-007 y AUD-004). Lo que dice de Railway está contrastado con su documentación oficial el 2026-10-09; donde no se pudo comprobar se
marca **«verificar»**. Si este documento y el código discrepan, gana el código.

## 1. Las partes

Todo vive en UN proyecto de Railway (entorno `production`), salvo los respaldos, que van a Cloudflare.

| Servicio | Qué es | Origen | Público | Inicio |
|---|---|---|---|---|
| `Postgres` | Base de datos (plantilla de Railway: PostgreSQL **18**) | plantilla `postgres` | no | — |
| `api` | La API Node | repo del backend, `Dockerfile` | **no** (solo `api.railway.internal`) | `node server.js` |
| `web` | El front (Vite) servido por Caddy, que reenvía `/api` y `/health` a `api` | repo del front, `Dockerfile` | **sí**, la única URL | Caddy |
| `respaldo` | Cron: `pg_dump` diario y subida a Cloudflare R2 | repo del backend, `Dockerfile` | no | `npm run backup` · `0 10 * * *` |
| `purga` | Cron: olvida IPs viejas (aviso de privacidad) | repo del backend, `Dockerfile` | no | `npm run purgar:ips` · `30 10 * * *` |
| `provision` | **Una sola vez**: roles de la base, migraciones, primer maestro. Se borra después | repo del backend, `Dockerfile` | no | ver §3 |
| Bucket R2 | Copias de la base fuera de Railway | Cloudflare | no | — |

Los cron de Railway corren en **UTC**, con mínimo de 5 minutos, y se saltan una corrida si la anterior sigue activa. `10:00 UTC` = `04:00` en México
(sin horario de verano desde 2022).

**Por qué `web` y `api` van detrás de una sola URL:** `up.railway.app` está en la Public Suffix List, así que `a.up.railway.app` y `b.up.railway.app`
son sitios distintos. Con dos servicios públicos la cookie de sesión sería de tercero (`SameSite=none`) y Safari/iPhone la bloquea. Con una sola
URL la cookie es normal (`Lax`), no hay CORS real y la API no se expone a internet.

**Por qué un Dockerfile:** los respaldos necesitan `pg_dump` de la misma versión mayor que el servidor (18), que no está en los repositorios de
Debian; el `Dockerfile` instala el cliente 18 del repositorio oficial de PostgreSQL y `rclone`.

## 2. Variables (solo nombres; los valores los genera Railway o los escribes tú en el panel)

Nunca pegues secretos en el chat ni en un archivo del repositorio. Para verificar usa el panel de Railway; la herramienta `list-variables` del
MCP devuelve los valores en claro y **no debe usarse**.

**Compartidas del entorno:** `GH_APP_PASSWORD`, `GH_MIGRADOR_PASSWORD` (contraseñas de los roles de la base; 32+ caracteres alfanuméricos).

| Variable | `api` | crons / `provision` | Valor |
|---|---|---|---|
| `NODE_ENV` | sí | sí | `production` (literal) |
| `DATABASE_URL` | sí | sí | `postgres://gh_app:${{shared.GH_APP_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}` |
| `MIGRATE_DATABASE_URL` | sí (pre-deploy) | `provision` | igual con `gh_migrador` y `GH_MIGRADOR_PASSWORD` |
| `ADMIN_DATABASE_URL` | no | **solo `provision`** | `${{Postgres.DATABASE_URL}}` (administrador de la plantilla) |
| `JWT_SECRET` | sí | no | 48+ caracteres aleatorios, propio de producción |
| `PIN_PEPPER` | sí | no | 32+, **distinto** de `JWT_SECRET` |
| `SETUP_TOKEN` | sí | no | 24+ |
| `CORS_ORIGINS` | sí | no | la URL pública de `web` (`https://….up.railway.app`) |
| `APP_URL` | sí | no | la misma URL |
| `TRUST_PROXY_HOPS` | sí | no | `2` (Railway → Caddy → API) |
| `TZ_NEGOCIO` | opcional | no | `America/Mexico_City` |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` | no | **solo `provision`** | correo del maestro y contraseña temporal (12+); los escribe quien administra |
| `BACKUP_UPLOAD_CMD` | no | `respaldo` | `rclone copy {file} r2:<bucket>/ && rclone delete r2:<bucket> --min-age 15d` |
| `RCLONE_CONFIG_R2_TYPE` / `_PROVIDER` / `_ENDPOINT` | no | `respaldo` | `s3` / `Cloudflare` / `https://<cuenta>.r2.cloudflarestorage.com` |
| `RCLONE_CONFIG_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | no | `respaldo` | token de R2 limitado a ESE bucket, solo escritura/lectura de objetos |
| `RCLONE_CONFIG_R2_NO_CHECK_BUCKET` | no | `respaldo` | `true` (el token no puede crear buckets) |
| `SMTP_*`, `MAIL_FROM` | opcional | no | vacías hasta tener dominio (§7); sin ellas el alta de empresa devuelve el enlace de activación |
| `SENTRY_DSN` | opcional | no | vacía: apagado |

No poner `PERMITIR_DB_SUPERUSUARIO`. Los secretos que Railway puede generar (`${{ secret(longitud, alfabeto) }}`) están documentados para
**plantillas**; **verificar** si funcionan en variables de un servicio común (probar primero con una variable sin importancia). Si no, se
generan en tu equipo (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) y los pegas tú en el panel.

## 3. Primera puesta, en este orden

1. Crear el proyecto y desplegar la plantilla `postgres`.
2. Crear `provision` (con las variables de §2) y arrancarlo con `sh -c "npm run db:roles && npm run migrate && npm run bootstrap:plataforma"`,
   política de reinicio **NEVER**. `db:roles` crea `gh_app` y `gh_migrador`; `migrate` aplica TODAS las migraciones (hasta la 054) como
   migrador; `bootstrap:plataforma` crea el primer maestro y su empresa «Plataforma». Revisar el log (no imprime correos ni contraseñas).
   Después **borrar el servicio** (tiene credenciales de administrador y la contraseña temporal).
3. Crear `api`: variables de §2; healthcheck `/health/ready`; pre-deploy `npm run migrate`; **sin dominio público**. Debe quedar sano.
4. Crear `web` (front) con dominio generado por Railway. Poner esa URL en `CORS_ORIGINS` y `APP_URL` de `api` y redesplegar `api`.
5. Crear el bucket de R2, el token limitado y los servicios `respaldo` y `purga`.
6. Crear los monitores externos (§5).

Mientras no se cargue otro, `/api/auth/setup` queda cerrado (ya existe un usuario) y exige además `x-setup-token`.

## 4. Lista de salida con evidencia

Cada fila se marca con fecha y qué se vio. Nada se da por hecho por haber configurado la variable.

| Comprobación | Cómo | Hallazgo |
|---|---|---|
| Arranque limpio | El log del primer arranque no trae «AVISO» ni «Configuración insegura» | AUD-007 |
| API sana por la URL pública | `GET https://<web>/health/ready` → 200 `ready`; `/health` → 200 | AUD-007 |
| Cookie correcta | `curl -i` del login: `Set-Cookie: gh_session=…; HttpOnly; Secure; SameSite=Lax` | AUD-007 |
| CORS | Una petición con `Origin` ajeno no recibe `Access-Control-Allow-Origin` | AUD-007 |
| Migraciones | `npm run migrate:status` (servicio de una sola vez) → todas `[x]`, última 054 | AUD-007 |
| Variables presentes | Por nombre, en el panel: las de §2 y ninguna `PERMITIR_DB_SUPERUSUARIO` | AUD-007 |
| `req.ip` correcto | Un login fallido deja en el log `ip` = la IP de quien probó, no la de Railway. Si sale la de Railway: probar `TRUST_PROXY_HOPS=1` o 3; si el borde no pone la IP en `X-Forwarded-For`, en el Caddyfile del front añadir `header_up X-Forwarded-For {header.X-Real-IP}` (Railway documenta `X-Real-IP`) y dejar `TRUST_PROXY_HOPS=1` | AUD-007 / AUD-011 |
| Tiempo real | Con el front, el SSE de cocina recibe un evento | AUD-007 |
| El monitor alerta | Pausar `api` unos minutos con aviso previo; llega el correo | AUD-007 |
| Sin contaminación | `npm run audit:tenant` y `npm run audit:correos` limpios (servicio de una sola vez) | AUD-003 |
| Respaldo sube | El primer `npm run backup` de producción aparece en R2 | AUD-004 |
| Restauración ensayada | Descargar ese archivo y restaurarlo en una base **separada** (`npm run backup:restore`, luego `backup:verify`); conteos iguales. Anotar fecha, archivo y conteos en [RESPALDOS.md](RESPALDOS.md) | AUD-004 |
| El cron corre solo | Al día siguiente hay un archivo nuevo en R2 y `purga` terminó sin error | AUD-004 / AUD-011 |

## 5. Monitor externo

UptimeRobot (plan gratis: comprobación **cada 5 minutos**, no cada minuto como supone el ideal de [OBSERVABILIDAD.md](OBSERVABILIDAD.md) §4.1).
Dos monitores HTTP sobre la URL pública de `web`: `/health/ready` (la base responde) y `/health` (el proceso responde); alerta por correo.
Con 5 minutos, «2 fallos seguidos» son ≈ 10 minutos hasta el aviso: aceptable para el piloto; un plan de pago baja el intervalo.

## 6. Límites conocidos del piloto

- **Los `Dockerfile` y el `Caddyfile` no se han construido localmente** (no hay Docker en el equipo de desarrollo): la primera construcción en Railway es la prueba real. Se esperan ajustes en esa primera vuelta.
- **Una sola instancia de API** (ADR-003). No subir réplicas sin revisar el SSE y los cachés en memoria.
- Las migraciones corren como pre-deploy del mismo servicio, así que la URL del migrador queda en el entorno de `api` ([DB_ROLES.md](DB_ROLES.md) §7).
- Sin dominio propio no hay correo transaccional: los enlaces de activación se entregan a mano.
- El tiempo real largo (SSE) pasa por dos proxies; **verificar** que ni el de Railway ni Caddy lo cortan antes de lo que el cliente tarda en reconectar.
- La cuenta de Railway es un punto único de fallo para la base **y** el servicio; por eso los respaldos van a Cloudflare, otra cuenta y otro proveedor.

## 7. Conectar el dominio propio (cuando se compre)

1. Comprarlo y agregarlo a `web` como dominio personalizado (registros CNAME y TXT que indica Railway; HTTPS automático). `api` sigue privada.
2. En `api`: `CORS_ORIGINS` con la URL vieja **y** la nueva durante la transición, y `APP_URL` con la nueva. La cookie no lleva dominio fijo, así que
   hay que volver a iniciar sesión en la URL nueva.
3. Correo: verificar el dominio en el proveedor SMTP (SPF/DKIM), cargar `SMTP_*` y `MAIL_FROM`, probar una invitación real.
4. Actualizar los monitores, el aviso de privacidad (proveedor de correo) y emparejar el agente de impresión con la URL nueva.
5. La URL `up.railway.app` sigue funcionando mientras no se quite; retirarla cuando todo use el dominio.
