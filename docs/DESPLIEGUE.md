# Despliegue a producción (Railway) y lista de salida

Estado: **desplegado en producción el 2026-10-09 (ADR-012)**; quedan por comprobar la cookie del login y el tiempo real (SSE), que exigen una sesión, y el dominio propio (§7). Este documento es a la vez la receta y el checklist con evidencia
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
| `TRUST_PROXY_HOPS` | sí | no | `3` (medido en producción el 2026-10-09: el borde de Railway pone dos saltos y Caddy el tercero) |
| `TZ_NEGOCIO` | opcional | no | `America/Mexico_City` |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` | no | **solo `provision`** | correo del maestro y contraseña temporal (12+); los escribe quien administra |
| `BACKUP_UPLOAD_CMD` | no | `respaldo` | `rclone copyto {file} r2:<bucket>/$(basename {file}) && rclone lsl r2:<bucket> && rclone delete r2:<bucket> --min-age 15d` (el `lsl` deja en el log la lista de copias: es la evidencia de que la subida llegó) |
| `RCLONE_CONFIG_R2_TYPE` / `_PROVIDER` / `_ENDPOINT` | no | `respaldo` | `s3` / `Cloudflare` / `https://<cuenta>.r2.cloudflarestorage.com` (**sin** `/<bucket>`: la URL «S3 API» del panel de Cloudflare lo trae y hay que quitárselo) |
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
| Cookie correcta | `read -rs P; curl -si https://<web>/api/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"<correo>\",\"password\":\"$P\"}" \| grep -i '^set-cookie' \| sed -E 's/(gh_session=)[^;]+/\1<oculto>/'; unset P` → `HttpOnly; Secure; SameSite=Lax`. **Comprobado el 2026-10-11:** `Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` (la cookie dura 7 días). Además, con la sesión del maestro: JavaScript no la ve (`document.cookie` vacío) y `/api/auth/me` responde 200; no hay JWT en `localStorage`, `sessionStorage` ni en el cuerpo del login | AUD-007 |
| CORS | Una petición con `Origin` ajeno no recibe `Access-Control-Allow-Origin` | AUD-007 |
| Migraciones | `npm run migrate:status` (servicio de una sola vez) → todas `[x]`, última 054 | AUD-007 |
| Variables presentes | Por nombre, en el panel: las de §2 y ninguna `PERMITIR_DB_SUPERUSUARIO` | AUD-007 |
| `req.ip` correcto | Un login fallido deja en el log `ip` = la IP de quien probó, no la de Railway. Medido el 2026-10-09: con `2` el log traía una IP del borde (`169.150…`) y con `3` la del cliente, también con `X-Forwarded-For`/`X-Real-IP` falsos en la petición. Si algún día vuelve a salir la de Railway: ajustar `TRUST_PROXY_HOPS`; si el borde no pone la IP en `X-Forwarded-For`, en el Caddyfile del front añadir `header_up X-Forwarded-For {header.X-Real-IP}` (Railway documenta `X-Real-IP`) y dejar `TRUST_PROXY_HOPS=1` | AUD-007 / AUD-011 |
| Tiempo real | Con el front, el SSE de cocina recibe un evento. **Comprobado el 2026-10-11** (65 s por Railway y Caddy, con la sesión del maestro): `GET /api/pos/1/eventos` → 200 `text/event-stream`, el aviso de conexión a los 0.3 s y un latido cada 20 s (20.2, 40.2 y 60.3 s), sin acumulación ni corte. No se probó con una comanda real ni más allá de 65 s | AUD-007 |
| El monitor alerta | Pausar `api` unos minutos con aviso previo; llega el correo | AUD-007 |
| Sin contaminación | `npm run audit:tenant` y `npm run audit:correos` limpios (servicio de una sola vez) | AUD-003 |
| Respaldo sube | El primer `npm run backup` de producción aparece en R2 | AUD-004 |
| Restauración ensayada | Descargar ese archivo y restaurarlo en una base **separada** (`npm run backup:restore`, luego `backup:verify`); conteos iguales. Anotar fecha, archivo y conteos en [RESPALDOS.md](RESPALDOS.md) | AUD-004 |
| El cron corre solo | Al día siguiente hay un archivo nuevo en R2 y `purga` terminó sin error | AUD-004 / AUD-011 |

### Registro de la primera puesta (2026-10-09)

Proyecto `NexoMesa` en Railway (plan Hobby), URL pública `https://web-production-3f7840.up.railway.app`. Los servicios `api`, `purga` y `respaldo`
construyen desde `main` del repositorio del backend, y `web` desde `main` del front (fusionados los PR #15 y #20; se reapuntaron desde las ramas `feat/…`
el 2026-10-09). Un push a `main` los redespliega.

| Comprobación | Resultado |
|---|---|
| Imagen del backend (Node 22, `pg_dump` 18.6, rclone 1.75.2) | construye en Railway (con rclone 1.60 de Debian la subida a R2 fallaba: ver §6) |
| Roles + migraciones 001–054 + primer maestro (`provision`) | OK; `audit:correos` limpio; `migrate:status` todas `[x]`; la pre-deploy de `api` dijo «Sin migraciones pendientes» |
| `${{ secret() }}` en variables de un servicio común | funciona y el valor es **estable** entre despliegues (huella igual en dos arranques) |
| Arranque de `api` | sin «AVISO» ni «Configuración insegura»; el guardia de rol de la base no abortó |
| `/health`, `/health/ready` por la URL pública | 200 / 200 (`ready`: la base responde) |
| SPA, ruta profunda, `sw.js` | 200; `sw.js` con `no-cache`; HSTS, `nosniff`, `Referrer-Policy` presentes |
| `/api/auth/me` sin sesión | 401 (el proxy a la API privada funciona) |
| CORS con `Origin` ajeno | sin `Access-Control-Allow-Origin` |
| `req.ip` | con `TRUST_PROXY_HOPS=2` el log traía una IP del borde; con **3** trae la del cliente, y un `X-Forwarded-For`/`X-Real-IP` falsos no la alteran |
| Cron `purga` | corrió: «0 fila(s) … 0 intento(s)» |
| Cron `respaldo` | `pg_dump` 18 OK y subida a R2 OK (ver abajo); con llaves de R2 **rotadas** (las primeras se pegaron en un chat) volvió a subir sin error |
| Monitores UptimeRobot (cada 5 min, alerta a carlos_360@outlook.es) | creados sobre `/health/ready` y `/health` |
| El monitor alerta | un monitor de prueba contra una URL que responde 404 cayó a los ≈ 5 min y UptimeRobot envió el correo (estado `SUCCESS`, 2 s después de detectar la caída); se borró. No se pausó producción para probarlo |
| Servicios en `main` | tras fusionar #15 (backend, `a5d81e4`) y #20 (front, `a31ec07`), `api`, `web`, `purga` y `respaldo` quedaron en `SUCCESS` construyendo desde `main` |
| Migraciones 053 y 054 en la base de desarrollo | aplicadas por el propietario (confirmado el 2026-10-09); producción las recibió con el aprovisionamiento |
| Servicio `provision` | borrado tras cambiar la contraseña temporal del maestro (guardaba la contraseña y las credenciales de administrador) |

**Respaldo y restauración (AUD-004), 2026-10-09:** el cron `respaldo` hizo `pg_dump` 18 de la base de producción y subió `railway-20261009-221503.dump` (188,817 bytes) a Cloudflare R2 (`nexomesa-respaldos`); `rclone lsl` lo listó en la raíz del bucket y la limpieza de copias de más de 15 días terminó sin error. Después se **descargó ese mismo archivo de R2** y `npm run backup:verify` lo restauró en una base temporal separada (`respaldo_verif_…`, ya borrada) con los conteos iguales a producción (empresas 1, usuarios 1, migraciones 54, el resto 0: base recién montada). Lección: la URL «S3 API» que muestra Cloudflare **incluye** `/<bucket>`; en `RCLONE_CONFIG_R2_ENDPOINT` va solo `https://<cuenta>.r2.cloudflarestorage.com`, sin el bucket. Con el bucket en el endpoint rclone sube a un prefijo equivocado y el listado da «directory not found».

**Pendiente de esta puesta:**

- Dominio propio y correo transaccional (§7).
- Aviso de privacidad: PR #21 del front (proveedores reales) fusionado. Revisión del abogado hecha (confirmada por el titular el 2026-10-10); el PR #22 del front quita los avisos de borrador y renombra los documentos a NexoMesa (la app los publica en `/legal/privacidad`). Pendiente solo: agregar el proveedor de correo al Aviso y al Acuerdo cuando se contrate.
- Un código de salida distinto de 0 no marca el servicio de una sola vez como fallido en Railway (`provision` salió con `SUCCESS` aunque `db:roles` falló): leer su log, no su estado.

## 5. Monitor externo

UptimeRobot (plan gratis: comprobación **cada 5 minutos**, no cada minuto como supone el ideal de [OBSERVABILIDAD.md](OBSERVABILIDAD.md) §4.1).
Dos monitores HTTP sobre la URL pública de `web`: `/health/ready` (la base responde) y `/health` (el proceso responde); alerta por correo.
Con 5 minutos, «2 fallos seguidos» son ≈ 10 minutos hasta el aviso: aceptable para el piloto; un plan de pago baja el intervalo.

## 6. Límites conocidos del piloto

- **Los `Dockerfile` y el `Caddyfile` no se han construido localmente** (no hay Docker en el equipo de desarrollo): la primera construcción en Railway es la prueba real. Se esperan ajustes en esa primera vuelta.
- **rclone viejo con R2:** el de Debian (1.60) daba `501 NotImplemented` en la primera subida y «directory not found» al limpiar, lo que dejaba la corrida como fallida. El `Dockerfile` instala rclone 1.75.2 fijo y verificado por SHA-256.
- **Docker Hub limita las descargas de los constructores de Railway** (429 Too Many Requests): el 2026-10-09 tumbó tres despliegues con «Failed to build an image» y sin log de build útil (la causa se ve en el log de build: `load metadata for docker.io/...`). Por eso los `FROM` usan el espejo de AWS ECR Public (`public.ecr.aws/docker/library/...`). Mientras un despliegue falla, el anterior sigue sirviendo.
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

## 8. Llevar el catálogo de otra instalación (p. ej. de tu base local a producción)

`npm run migrar:catalogo` copia **proveedores, categorías y productos** de una empresa de tu base local a una empresa de otra instalación, **por la API** de esa
instalación (pasa por sus validaciones y su bitácora; no hace falta abrir la base de producción a internet). Por defecto solo simula.

1. **Crear la empresa en el destino.** Con el usuario maestro: Plataforma → Empresas → nueva empresa, con el correo de su Owner (el correo es único en toda la
   plataforma: no puede ser el del maestro). Sin dominio no hay correo: la contraseña temporal se entrega a mano. Anota el **id** de la empresa nueva.
2. **Simular** (no escribe nada ni contacta el destino; valida todo con los esquemas reales de la app):
   `npm run migrar:catalogo -- --origen <id de la empresa en tu base local>`
3. **Aplicar** (te pide la contraseña sin mostrarla; sirve la del Owner, o la del maestro si tiene acceso compartido a esa empresa):
   `npm run migrar:catalogo -- --origen <id> --destino https://<web>.up.railway.app --destino-empresa <id nuevo> --email <correo> --aplicar`

Qué hace y qué no: el stock inicial es **0** (se conservan el mínimo y el máximo; `--stock-actual` copia el stock del origen); omite los productos **inactivos**
(`--incluir-inactivos` los lleva y los deja inactivos) y los **elaborados**, que nacen de recetas; lleva solo los proveedores que algún producto necesita; no
lleva recetas, mesas, usuarios, ventas, compras ni movimientos. Es **repetible**: antes de crear consulta lo que ya hay y omite lo que existe con el mismo
nombre. Al terminar imprime cuántos creó, cuántos ya existían y los errores, sin datos sensibles. Primera migración real (Café Aroma, empresa 4 → producción):
el registro de abajo.

### Registro de la primera migración real (2026-10-10)

- Origen: Café Aroma, empresa 4 de la base local. Destino: la empresa **«Aroma», id 2**, de producción, con un Owner con correo distinto al del maestro.
- Aplicada por el titular con `--aplicar` (stock inicial 0). Informe del propio script, con sesión iniciada en la empresa activa 2: a llevar 12 proveedores, 18 categorías y 138 productos; omitidos 27 (25 inactivos y 2 elaborados, que nacen de una receta); **creados 12 proveedores, 18 categorías y 138 productos**; ya existían 0 de cada uno (primera corrida, nada duplicado). Coincide con la simulación previa.
- Es el informe de la herramienta, no un recuento independiente de la base. Para repetirla sin duplicar basta volver a correr el comando: omite lo que ya existe por nombre.
