# Observabilidad y alertas

Qué deja el backend en el log, cómo buscarlo en Railway, qué debe alertar y qué hacer cuando suena. Es la parte operativa de la Fase 6
(ADR-009). Decisión de alertas: **opción B** (logs + monitor externo) como base, con **Sentry (opción A) listo pero apagado**.

> Lo que dice de Railway y de Sentry está contrastado con su documentación oficial el 2026-10-09. Donde no se pudo comprobar se indica
> «verificar en el panel».

## 1. Cómo es una línea de log

Una línea JSON por evento, en stdout (Railway la recoge y la indexa por atributos). Campos que siempre están:

| Campo | Qué es |
|---|---|
| `ts`, `level`, `message` | Cuándo, gravedad (`info` / `warn` / `error`) y el **nombre del evento** (por lo que se busca y se alerta). |
| `requestId` | Id de la petición. Es el mismo que va en la cabecera de respuesta `X-Request-Id` y en el JSON de un 500. Si alguien reporta un fallo, con ese id se encuentra todo lo que pasó. |
| `ip`, `usuario_id`, `empresa_id` | Desde dónde y quién (empresa **activa** de la sesión). Nulos si no hay sesión. |

Qué **nunca** sale: contraseñas, PIN, tokens (invitación, sesión, agente), cookies, cabeceras `Authorization`, valores de columnas de la base,
la query de una URL (solo los nombres de los parámetros), correos en claro (`c***@dominio.com`). Lo garantiza `src/utils/redactar.js` en el
propio logger y lo comprueban las pruebas de `test/integration/log-sin-secretos.test.js`.

Las consultas a `/health` y `/health/ready` no se registran; la caída de la base se cuenta con `readiness_caida` (sección 3).

## 2. Buscar en Railway

Railway entiende el JSON: cada campo es un atributo filtrable (sintaxis de su Log Explorer).

| Qué buscas | Filtro |
|---|---|
| Todos los errores | `@level:error` |
| Un evento concreto | `@evento:login_fallido` (eventos de seguridad) · la palabra `readiness_caida` tal cual (el resto) |
| Todo lo de una petición | `@requestId:<id>` |
| Una IP | `@ip:203.0.113.7` |
| Una empresa | `@empresa_id:12` |
| Combinar | `@evento:login_fallido AND @ip:203.0.113.7` |

Límites de Railway a tener presentes: retención de logs según el plan (Free 3 días, Hobby 7, Pro 30, Enterprise hasta 90) y tope de
**500 líneas por segundo por réplica** (lo que pase se descarta). Con el volumen actual no se acerca, pero un ataque de fuerza bruta sí
podría: por eso `limite_excedido` se escribe una sola vez por IP y minuto.

## 3. Catálogo de eventos

### Eventos de seguridad (`message: "security"`, campo `evento`)

Nombres estables: se pueden añadir, **no renombrar** (las alertas dependen de ellos). El catálogo vive en `src/utils/seguridad.js` y una
prueba exige que esta tabla y el código estén de acuerdo.

| Evento | Qué significa | Gravedad sugerida |
|---|---|---|
| `login_fallido` | Correo o contraseña incorrectos (el `motivo` solo está en el log) | media si se repite desde una IP |
| `login_bloqueado` | Contraseña correcta, pero cuenta o empresa desactivadas | baja |
| `password_actual_incorrecta` | Cambio de contraseña con la actual equivocada | baja |
| `setup_token_invalido` | Intento de setup con un `SETUP_TOKEN` equivocado | alta |
| `invitacion_invalida` | Enlace de invitación inválido, usado o vencido | baja |
| `token_invalido` | Token alterado, falsificado o vencido | baja (media en ráfaga) |
| `csrf_faltante` | Escritura con cookie sin la cabecera anti-CSRF | media |
| `sesion_revocada` | Token de una sesión ya cerrada | informativa |
| `usuario_desactivado` | Sesión de un usuario desactivado | informativa |
| `empresa_desactivada` | Sesión de una empresa desactivada | informativa |
| `sesion_empresa_invalida` | El token apunta a una empresa que ya no le corresponde (p. ej. se le retiró el acceso compartido) | informativa |
| `sesion_pin_invalida` | Sesión de PIN que ya no vale (equipo revocado, ascendido, empresa compartida) | informativa |
| `cambio_empresa_denegado` | Intento de cambiar a una empresa sin acceso | media |
| `empresa_ajena` | Una petición pide datos de una empresa distinta a la del token | **alta** (sondeo entre empresas) |
| `recurso_ajeno` | Una petición pide un recurso de otra empresa | **alta** |
| `permiso_denegado` | Acción que el rol no permite | baja |
| `pin_fallido` | PIN incorrecto | baja |
| `pin_en_espera` | PIN rechazado por enfriamiento tras varios fallos | media |
| `pin_bloqueado` | PIN bloqueado: solo un administrador lo desbloquea | media |
| `equipo_no_registrado` | Ingreso con PIN desde un equipo no registrado o revocado | media |
| `equipo_codigo_invalido` | Código de registro de equipo inválido o vencido | media en ráfaga |
| `agente_token_invalido` | Token de agente de impresión ausente, inválido o desactivado | media |
| `agente_codigo_invalido` | Código de emparejamiento de agente inválido o vencido | media en ráfaga |
| `supervisor_credenciales_invalidas` | Credenciales de supervisor equivocadas al autorizar una acción | media |
| `limite_excedido` | Se superó el límite de peticiones por minuto de una ruta | media |
| `acceso_compartido_concedido` | El maestro dio a una persona acceso a otra empresa | informativa (auditoría) |
| `acceso_compartido_retirado` | Se retiró el acceso a una empresa (`por`: maestro u owner) | informativa (auditoría) |

### Otros eventos del log

| Evento (`message`) | Nivel | Qué significa |
|---|---|---|
| `request` | info / warn / error | Una petición: método, ruta (sin query y con tokens enmascarados), status y duración. 4xx = `warn`, 5xx = `error`. |
| `unhandled_error` | error | Un 500 inesperado, con su stack saneado. El cliente recibe el `requestId`. |
| `db_error` | warn | Error de la base mapeado a un 4xx (duplicado, referencia inválida…). |
| `unhandled_rejection` | error | Una promesa rechazada que nadie capturó. **El proceso se cierra** (código 1) y Railway lo reinicia. |
| `uncaught_exception` | error | Una excepción que nadie capturó. Igual: el proceso se cierra y se reinicia. |
| `cierre_ordenado` | info | El cierre tras un error fatal terminó bien. |
| `cierre_forzado` | error | El cierre tras un error fatal no terminó en 3 s y se salió igual. |
| `cierre_fallido` | error | Algo falló al cerrar tras un error fatal. |
| `fatal_repetido` | error | Un segundo error fatal mientras ya se cerraba. |
| `eventos_pos_envio` | warn | Falló el envío de un aviso en tiempo real (SSE) a un suscriptor. Los demás suscriptores reciben el aviso; el front se recupera con su sondeo de respaldo. |
| `eventos_pos_caida` | warn | Se cayó la conexión de escucha de avisos (`LISTEN`). El servidor reintenta solo. Si se repite, mirar la base. |
| `idempotencia_guardar` | warn | No se pudo guardar la respuesta de una operación con `Idempotency-Key`. La operación sí se hizo; un reintento recibirá «ya se procesó pero su respuesta no está disponible». |
| `idempotencia_purga` | warn | Falló la limpieza de llaves de idempotencia antiguas. Inofensivo: se vuelve a intentar en otra petición. |
| `readiness_caida` | error | `/health/ready` empezó a fallar: la base no responde (o tarda más de 5 s). |
| `readiness_sigue_caida` | error | Recordatorio cada 5 min mientras siga caída, con cuánto lleva. |
| `readiness_recuperada` | info | La base volvió; incluye la duración de la caída. |
| `admin_actividad_fallida` | error | No se pudo escribir una fila de la bitácora de acciones (sección 3 bis) DESPUÉS de que la acción ya se hizo. La acción no se deshace; la fila falta y este evento dice cuál (`accion`, `empresa_id`, `requestId`). |
| `sentry_activo` | info | Sentry se encendió (hay `SENTRY_DSN`). |
| `sentry_no_inicia` | error | Hay `SENTRY_DSN` pero Sentry no quedó activo (DSN mal escrito, paquete ausente). El servidor arranca igual. |
| `sentry_captura_fallida` | warn | Sentry falló al recibir un error; se ignora. |

## 3 bis. Bitácora de acciones administrativas

Además del log, las acciones **administrativas** quedan en la tabla `admin_actividad` de la base (migración 052): quién cambió qué, sobre qué, cuándo y
desde dónde. A diferencia del log, no caduca con la retención de Railway y se puede consultar con SQL.

- **Solo se inserta y se lee.** La aplicación (`gh_app`) no tiene UPDATE, DELETE ni TRUNCATE sobre esa tabla: ni un fallo de la aplicación ni una
  persona con acceso a ella puede reescribir lo registrado. Lo comprueba una prueba contra la base real.
- **Sin claves foráneas, a propósito**: sobrevive a que se borre una empresa o un usuario.
- **Columnas**: `creado_at`, `empresa_id` (la empresa **afectada**), `actor_id`, `actor_empresa_id` (la empresa activa de quien actuó; distinta cuando
  actúa el maestro o alguien con acceso compartido), `accion`, `objeto_tipo`, `objeto_id`, `detalle` (json), `ip`, `request_id`.
- **El `detalle` nunca lleva secretos**: ni contraseñas, ni PIN, ni tokens, ni códigos; solo ids, nombres de campos y banderas (p. ej.
  `contrasena_cambiada: true`). Además pasa por el saneador del log.
- **Cuándo se escribe**: las dos acciones que ya tienen una transacción propia registran **dentro de ella**: `plataforma.empresa_crear` (si no se
  puede registrar, no se crea la empresa ni su Owner) y `empresa.configuracion_actualizar` (si no se puede registrar, no cambia ni la
  configuración ni el IVA de las recetas). Las demás acciones se registran justo **después** de tener éxito; si la bitácora falla, la acción no se
  deshace y queda `admin_actividad_fallida` en el log. Las funciones transaccionales **exigen** el contexto de la bitácora: sin él ni abren la
  transacción.
- Con el `request_id` de una fila se encuentran en el log todas las líneas de esa petición, y al revés.

Consulta de ejemplo (con un usuario que pueda leer la tabla; hoy no hay pantalla ni endpoint, ver la sección 8):

```sql
SELECT creado_at, accion, actor_id, objeto_tipo, objeto_id, detalle, ip
FROM admin_actividad WHERE empresa_id = 12 ORDER BY creado_at DESC LIMIT 50;
```

### Acciones de la bitácora

Nombres estables: se pueden añadir, **no renombrar**. El catálogo vive en `src/modules/actividad/actividad.js`.

| Acción | Qué significa |
|---|---|
| `usuario.crear` | Se dio de alta a un usuario |
| `usuario.actualizar` | Se cambió un usuario (rol, estado, correo, contraseña, cierre de sesiones…) |
| `pin.definir` | Se definió o cambió el PIN de un usuario |
| `pin.quitar` | Se quitó el PIN de un usuario |
| `pin.desbloquear` | Se desbloqueó el PIN de un usuario |
| `equipo.crear` | Se registró un equipo nuevo (con su código de un solo uso) |
| `equipo.actualizar` | Se renombró un equipo |
| `equipo.codigo_nuevo` | Se generó un código nuevo para un equipo |
| `equipo.revocar` | Se revocó un equipo |
| `agente.crear` | Se creó un agente de impresión |
| `agente.actualizar` | Se cambió un agente de impresión (nombre o estado) |
| `agente.eliminar` | Se eliminó un agente de impresión |
| `agente.rotar_token` | Se renovó el token de un agente |
| `agente.codigo` | Se generó un código de emparejamiento para un agente |
| `acceso.conceder` | El maestro dio a una persona acceso a otra empresa |
| `acceso.retirar` | Se retiró a una persona el acceso a una empresa (`por`: maestro u owner) |
| `plataforma.empresa_crear` | El maestro creó una empresa con su Owner (en la misma transacción) |
| `plataforma.empresa_estado` | El maestro activó o desactivó una empresa |
| `plataforma.invitacion_reenviar` | El maestro reenvió la invitación de un Owner |
| `plataforma.owner_password_resetear` | El maestro restableció la contraseña de un Owner |
| `empresa.configuracion_actualizar` | Se cambió la configuración de la empresa (en la misma transacción; `detalle.recetas_actualizadas` dice cuántas recetas tocó el IVA) |

## 4. Qué debe alertar

Los umbrales son un **punto de partida**: se ajustan cuando haya tráfico real. Urgencia: **crítica** = avisar de inmediato; **alta** = el mismo
día; **media** = revisar en el resumen diario.

| Qué | Condición | Urgencia | Cómo se detecta hoy |
|---|---|---|---|
| API caída | `GET /health/ready` no responde 200 en 2 comprobaciones seguidas (≈ 2 min) | crítica | Monitor externo (4.1) |
| Proceso reiniciado por un error | `unhandled_rejection`, `uncaught_exception` o `cierre_forzado`: 1 o más | crítica | Sentry (4.2) o log |
| Base caída | `readiness_caida`: 1 o más | crítica | Monitor externo; log |
| 500 repetidos | `unhandled_error` ≥ 3 en 5 min | alta | Sentry o log |
| Sondeo entre empresas | `empresa_ajena` o `recurso_ajeno`: 1 o más | alta | Log |
| Intento de setup ajeno | `setup_token_invalido`: 1 o más | alta | Log |
| Fuerza bruta | `login_fallido` ≥ 10 en 10 min desde la misma IP | media | Log |
| Límite superado | `limite_excedido` ≥ 5 en 10 min | media | Log |
| Supervisor adivinado | `supervisor_credenciales_invalidas` ≥ 3 en 10 min | media | Log |
| Equipos o agentes con códigos inválidos | `equipo_codigo_invalido` o `agente_codigo_invalido` ≥ 5 en 10 min | media | Log |

### 4.1 Monitor externo (obligatorio, el primero que hay que poner)

Railway **no vigila el healthcheck de forma continua**: lo consulta solo al desplegar. Hace falta un monitor externo que consulte
`https://<tu-api>/health/ready` cada minuto y avise por correo tras 2 fallos seguidos (el plan gratis de UptimeRobot comprueba cada 5 minutos: el aviso tarda ≈ 10; ver [DESPLIEGUE.md](DESPLIEGUE.md) §5). Opciones: cualquier servicio de uptime con plan
gratuito, o la plantilla **Uptime Kuma** del marketplace de Railway (la que su propia documentación recomienda para esto). Conviene vigilar
también `/health` (liveness) para distinguir «el proceso no responde» de «la base no responde».

Además, Railway puede enviar un webhook en eventos de despliegue y de caída del servicio (p. ej. `Deployment.failed`); su documentación incluye
una guía para recibirlos («Set Up Alerts for Crashes, Restarts, and Failed Deploys»). Útil para cerrar el hueco de un despliegue fallido.

### 4.2 Alertas por log

Railway **no tiene un ajuste de drenaje de logs** (su documentación recomienda un reenviador como Vector o Fluent Bit, o enviar los logs
desde la app) y no encontré en ella alertas sobre el contenido de los logs (verificar en el panel de Observabilidad si ofrece monitores
que lo permitan). Para alertar por log lo seguro es reenviar stdout a un agregador y definir allí las reglas de la tabla. Hasta entonces:

- Los errores graves (500, caídas del proceso) llegan por **Sentry** cuando se encienda (sección 5).
- El resto se revisa a mano en el Log Explorer con los filtros de la sección 2. Una vez al día basta: `@level:error`, y `@evento:empresa_ajena`.

### 4.3 Canal

Correo, para empezar (decidido). WhatsApp o Slack se añaden en el monitor o en el agregador, sin tocar el código.

## 5. Sentry (opción A): listo pero apagado

Sin `SENTRY_DSN` el paquete ni se carga: cero efecto. Para encenderlo, crear un proyecto Node en Sentry y poner en Railway:

```
SENTRY_DSN=https://<clave>@o<id>.ingest.sentry.io/<proyecto>
SENTRY_ENVIRONMENT=production      # opcional; por defecto NODE_ENV
SENTRY_RELEASE=                    # opcional; por defecto RAILWAY_GIT_COMMIT_SHA
```

Al arrancar queda `sentry_activo` en el log. Si el DSN está mal escrito queda `sentry_no_inicia` y el servidor arranca igual.

**Qué envía:** solo los 500 inesperados y los fallos fatales del proceso (`unhandled_error`, `unhandled_rejection`, `uncaught_exception`), con
el stack, y como etiquetas el tipo de error, el `requestId` y el `empresa_id`. Con el `requestId` se llega a las líneas del log.

**Qué no envía:** peticiones, cabeceras, cookies, cuerpos, parámetros de URL, usuario, IP, breadcrumbs, variables locales ni código fuente,
ni el nombre de la máquina (`server_name` fijo `api`). Se logra apagando todo el contexto del SDK y con un saneador final (`beforeSend`);
una prueba contra el SDK real comprueba el envelope que sale.

**Probarlo:** con el DSN puesto, provocar un error (p. ej. un despliegue de prueba) y comprobar que llega. Para apagarlo: quitar `SENTRY_DSN`.

## 6. Privacidad y retención

Dónde queda cada dato personal y por cuánto tiempo. **El aviso de privacidad (`GastronyHub/legal/aviso-de-privacidad.md`) debe decir esto mismo**;
si cambia algo de aquí, cambia el aviso (AUD-011).

| Dato | Dónde vive | Retención real | Cómo se cumple |
|---|---|---|---|
| IP, `usuario_id`, `empresa_id`, `requestId` en cada petición y en los eventos de seguridad | Log de Railway | Según el plan de Railway: 3 días (Free), 7 (Hobby), 30 (Pro), hasta 90 (Enterprise) | Lo hace Railway; no hay copia nuestra |
| IP de la bitácora de acciones administrativas (`admin_actividad.ip`) | Base de datos | **12 meses**; después la fila se conserva y la IP se pone en NULL | `npm run purgar:ips` (migración 054) |
| El resto de `admin_actividad` (quién, qué, sobre qué, cuándo) | Base de datos | Sin plazo: es el registro de auditoría de la empresa | — |
| IP de los intentos fallidos de PIN (`pin_fallos.ip`) | Base de datos | **Hasta 2 días** (se borran los de más de 1 día; solo sirven para contar en ventanas de minutos) | `npm run purgar:ips` |
| Respaldos de la base (contienen todo lo anterior) | Fuera del servidor (destino externo) | Los últimos 14 (`BACKUP_KEEP`) | [RESPALDOS.md](RESPALDOS.md) |

- **Programar la purga.** `npm run purgar:ips` corre con el rol de la app (`gh_app`; no necesita credenciales de dueño) y es idempotente. Debe correr
  **a diario**: en Railway, un servicio *cron* aparte con `DATABASE_URL` y `npm run purgar:ips`. Hasta que esté programado, la promesa de 12 meses no se cumple:
  verificarlo es parte de la lista de salida a producción.
- Las IP de los respaldos conservan lo que había en el momento del respaldo; caducan al rotar los 14 respaldos (con el respaldo diario, ~2 semanas).
- Los correos nunca salen completos en el log; las contraseñas, PIN y tokens, jamás.
- Sentry (si se enciende) es otro tratamiento de datos y otro proveedor: reflejarlo también en el aviso. Solo recibe errores y ids técnicos.

## 7. Qué hacer cuando suena

| Alerta | Primero mirar | Después |
|---|---|---|
| API caída (monitor) | Estado del servicio y del último despliegue en Railway; `@level:error` de los últimos minutos | Si es un despliegue malo, revertir al anterior |
| `readiness_caida` | Servicio de Postgres en Railway (¿reiniciando, sin espacio, sin conexiones?) | Con la base de vuelta aparece `readiness_recuperada` con la duración |
| `unhandled_rejection` / `uncaught_exception` | La línea trae `error` y `stack`; el `requestId` de las líneas anteriores dice qué petición lo causó | Corregir y desplegar: el proceso ya se reinició solo |
| `unhandled_error` en ráfaga | Buscar por `requestId` el contexto; ¿una sola ruta, una sola empresa? | Si es una empresa, revisar sus datos antes de culpar al código |
| `empresa_ajena` / `recurso_ajeno` | `usuario_id`, `empresa_id` (la del token), `empresa_solicitada`, `ip` | Un error del front puede provocarlo una vez; un patrón repetido es un sondeo: valorar desactivar al usuario |
| `login_fallido` desde una IP | `motivo` y `correo` (enmascarado) de cada intento | El límite de 10 por minuto ya frena; bloquear la IP en el proxy si sigue |
| `pin_bloqueado` | `usuario_id` y `equipo` | Un administrador lo desbloquea desde Usuarios; averiguar si fue la persona o alguien probando |

## 8. Límites conocidos

- El estado de `readiness_*` y los avisos de límite viven en la **memoria de cada instancia**. Con una sola instancia (el lanzamiento) no hay
  problema; con varias, cada una avisa su propia caída y no se suman.
- Revocar un acceso o desactivar una empresa puede tardar hasta 60 s en verse en las demás instancias (caché); durante ese lapso aparecerán
  menos eventos `sesion_*` de los que cabría esperar.
- La bitácora `admin_actividad` se escribe pero **aún no se puede ver desde la aplicación** (ni endpoint ni pantalla): se consulta con SQL. Un
  endpoint de lectura para el Owner y una pantalla quedan para después de ver cómo se llena.
- Algunas acciones son **varias consultas sueltas, sin transacción** (ya era así antes de la bitácora): `usuario.actualizar` (cambia el usuario y
  luego renueva su `token_version`), `agente.crear` (crea el agente y luego su código) y `equipo.crear` (crea y luego lee). Si falla a medias,
  queda el efecto parcial y **no** hay fila de bitácora (el usuario recibe un 500). Pendiente de una mejora aparte: envolver `usuario.actualizar`
  en una transacción.
- La bitácora cubre las acciones listadas en la sección 3 bis. Los cambios de datos de negocio (productos, compras, ventas…) tienen su propio historial
  en sus tablas y no pasan por aquí.
- Las alertas por contenido de log dependen de reenviar los logs a un agregador (4.2) o de que el panel de Railway ofrezca alguna; mientras no exista, se revisa a mano.

## 9. Mantener este documento

Añadir un evento = declararlo en `src/utils/seguridad.js` (o emitirlo con el logger) y añadir su fila aquí. `test/observabilidad-doc.test.js`
falla si una tabla y el código se separan, o si se renombra un evento sin actualizar el documento.
