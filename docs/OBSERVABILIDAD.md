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
| `sentry_activo` | info | Sentry se encendió (hay `SENTRY_DSN`). |
| `sentry_no_inicia` | error | Hay `SENTRY_DSN` pero Sentry no quedó activo (DSN mal escrito, paquete ausente). El servidor arranca igual. |
| `sentry_captura_fallida` | warn | Sentry falló al recibir un error; se ignora. |

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
`https://<tu-api>/health/ready` cada minuto y avise por correo tras 2 fallos seguidos. Opciones: cualquier servicio de uptime con plan
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

## 6. Privacidad

- La **IP** (en `request` y en los eventos de seguridad) y el `usuario_id` son datos personales. Hay que mencionarlos en el aviso de privacidad de la
  aplicación (existe el módulo `legal` en el front) y entender que viven en los logs de Railway durante el plazo de retención de su plan.
- Los correos nunca salen completos; las contraseñas, PIN y tokens, jamás.
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
- No hay aún bitácora de acciones administrativas en base de datos (`admin_actividad`, paso 7 de la Fase 6): hoy solo hay
  `acceso_compartido_*` en el log, que caduca con la retención del plan.
- Las alertas por contenido de log dependen de reenviar los logs a un agregador (4.2) o de que el panel de Railway ofrezca alguna; mientras no exista, se revisa a mano.

## 9. Mantener este documento

Añadir un evento = declararlo en `src/utils/seguridad.js` (o emitirlo con el logger) y añadir su fila aquí. `test/observabilidad-doc.test.js`
falla si una tabla y el código se separan, o si se renombra un evento sin actualizar el documento.
