# Estrategia de autenticación

Estado: **vigente desde la Fase 2 (2026-10-07)** · decisión: ADR-002 · fuente de verdad: el código (`src/middlewares/auth.js`, `activeUser.js`, `utils/authCookie.js`, `modules/auth/`). Si este documento y el código discrepan, gana el código: corrige el documento.

## 1. Resumen

| Cliente | Cómo se autentica | Qué recibe |
|---|---|---|
| **Web (React)** | `POST /api/auth/login` con correo y contraseña | JWT **solo** en la cookie `gh_session` (httpOnly). El body **no** trae el token |
| **Web, equipo de piso** | PIN en un equipo registrado (`POST /api/auth/pin`) | Misma cookie, con una sesión más corta y sin poderes de Admin (ver §6) |
| **Agente de impresión** | `Authorization: Bearer gh_agt_…` (token propio, no es un JWT de usuario) | Rutas `/api/agente/*` únicamente |
| **Integraciones / apps móviles** | **No existen hoy.** No hay API tokens | — |

Lo que **no** se hace, a propósito: ningún endpoint devuelve el JWT de sesión en el body (ni `login`, ni `setup`, ni PIN, ni aceptar invitación); no se guarda el token en `localStorage`/`sessionStorage`; no hay refresh tokens.

## 2. Cookie de sesión

- Nombre `gh_session`, `HttpOnly`, `Path=/`, `maxAge` = `JWT_EXPIRES` (7 d por defecto).
- `SameSite=Lax` por defecto (`COOKIE_SAMESITE`). `Secure` en producción, o si `SameSite=None` (obligatorio en ese caso). `COOKIE_DOMAIN` opcional.
- Despliegue con front y back en **dominios distintos** (p. ej. dos `*.up.railway.app`) exige `COOKIE_SAMESITE=none` + HTTPS: en ese modo el navegador ya envía la cookie entre sitios y la defensa anti-CSRF descansa en §3. Preferible un dominio común (`app.` + `api.`) con `lax`.
- `POST /api/auth/logout` borra la cookie **de ese navegador**. No revoca el JWT (ver §5, límites).

## 3. Protección CSRF

- Con cookie, toda petición **no segura** (no GET/HEAD/OPTIONS) debe llevar el header `X-Requested-With`; si falta → `403`. Un sitio ajeno no puede añadir ese header sin pasar por un preflight CORS, y el CORS solo permite los orígenes de `CORS_ORIGINS` (con credenciales no se admite `*`).
- La petición con `Authorization: Bearer` **no** está sujeta a ese header: un Bearer no viaja solo (no es una credencial «ambiental» como la cookie), así que no hay CSRF que evitar.
- Probado: `test/integration/auth-sesion.test.js` (cookie sin header → 403; con header → 200; Bearer sin header → 200).

## 4. `Authorization: Bearer` — se conserva, sin construir tokens de API

El middleware sigue aceptando `Authorization: Bearer <jwt>` **como mecanismo, no como producto**:

- Hoy lo usan las pruebas automatizadas y, de forma manual, la colección de Postman (`docs/postman_collection.json`; su script de *Login* lee el JWT de la cabecera `Set-Cookie` para reutilizarlo como Bearer).
- Ningún endpoint **emite** ese token en el body. Quien quiera uno debe hacer login y leerlo de la cookie (herramientas de desarrollo).
- **No usar el JWT de sesión para integraciones de terceros.** Cuando exista una integración real (disparador abajo) se construirán *API tokens* propios: alcance acotado, expiración, revocación individual, almacenados solo como hash y mostrados una vez (el patrón ya existe en los tokens `gh_agt_…` del agente y en los códigos de emparejamiento).
- **Disparador para construirlos:** una integración externa aprobada, o una app móvil. Mientras tanto, no se construyen (decisión del propietario).

## 5. Vida de la sesión y revocación

- **Contenido del JWT (HS256, firmado con `JWT_SECRET`):** `id`, `empresa_id`, `is_admin`, `is_owner`, `is_platform_admin`, `role_id`, `tv` (versión del token). Las sesiones de PIN añaden `pin: true` y `disp` (equipo). El rol efectivo **no se confía** al JWT: `requireActiveUser` lo refresca desde la base en cada petición.
- **Expiración:** 7 días (login con contraseña), 12 horas (PIN; `PIN_SESSION_EXPIRES`). Sin refresh: al vencer, se vuelve a iniciar sesión.
- **Revocación por usuario:** `usuarios.token_version` (`tv`). Si el `tv` del JWT no coincide con el de la base → `401`. Lo suben: «cerrar todas las sesiones», cambio de contraseña, activación por invitación, restablecimiento por la plataforma. Un usuario o empresa desactivados pierden acceso aunque el JWT no haya vencido.
- **Latencia de la revocación:** el estado del usuario se cachea ≤ 60 s **por proceso**. Con una sola instancia, la revocación hecha en esa instancia es inmediata (la caché se invalida); un cambio hecho directamente en la base tarda hasta 60 s. Con ≥ 2 instancias hay que invalidar con `NOTIFY` (ADR-003).
- **Límites conocidos (aceptados, documentados):**
  1. No hay revocación de **un solo** JWT (no existe `jti`): un JWT robado sigue valiendo hasta que se suba `token_version` o venza, **incluso después de `POST /logout`** de ese dispositivo. El remedio es «cerrar todas las sesiones».
  2. 7 días es una ventana larga para un POS; la mitigan la revocación por `tv`, la cookie httpOnly y el refresco de rol desde la base. Acortarla es una decisión de producto, no técnica.
  3. HS256 con un secreto compartido: quien conozca `JWT_SECRET` puede forjar sesiones. Por eso la guardia de arranque (Fase 1) rechaza secretos de ejemplo/débiles y el secreto no se reutiliza entre entornos.

## 6. Ingreso con PIN (equipos de piso)

- Solo en equipos **registrados** por un Admin (código de un solo uso, 15 min, guardado como hash); el equipo se identifica con la cookie `gh_device` (httpOnly, `Path=/api/auth`).
- La sesión de PIN dura un turno, **nunca** es Admin (aunque la persona lo sea), y no autoriza a supervisores. Si la persona es ascendida a Admin, la sesión de PIN deja de valer.
- Bloqueos: por usuario+equipo, por equipo, por IP, y un bloqueo duro tras 10 fallos/h que solo un Admin quita. Hash `bcrypt(HMAC(PIN_PEPPER, id:pin))`; `PIN_PEPPER` es independiente de `JWT_SECRET` en producción (Fase 1).

## 7. Endurecimiento del login y del arranque

- Límite de `10` intentos/min/IP en `/api/auth/login` (y topes en PIN, registro de equipo y emparejamiento del agente). Los límites son en memoria **por proceso**.
- Tiempo de respuesta igualado entre «correo inexistente» y «contraseña incorrecta» (hash ficticio), mensaje genérico, correo normalizado.
- `POST /api/auth/setup` solo funciona si **no existe ningún usuario**; en producción exige el header `x-setup-token` (`SETUP_TOKEN`, 24+ caracteres).
- El servidor no arranca en producción con secretos de ejemplo, repetitivos, cortos o repetidos entre sí (`src/config/env.js`).

## 8. Cómo probarlo (Postman / terminal)

- **Postman:** ejecutar *Auth → Login*. El script guarda el JWT leído de `Set-Cookie` en la variable `token`; la colección usa Bearer con ella. Si la cookie no llega, la prueba del script falla con un mensaje claro.
- **Terminal:** `curl -i -X POST $API/api/auth/login -H 'Content-Type: application/json' -d '{"email":"…","password":"…"}'` — el JWT va en `Set-Cookie`, no en el body.
- **Diagnóstico:** `LOGIN_PASSWORD='…' npm run diagnosticar:login -- correo@dominio.com` comprueba la cookie y que el body **no** incluya `token` (si lo incluye, el backend en ejecución es una versión anterior).

## 9. Decisiones abiertas

- Duración de la sesión web (7 d) y si conviene un `jti` para revocar un solo token: se reevalúa si hay un incidente de robo de sesión o un requisito de un cliente.
- API tokens (§4): al aprobar la primera integración o app móvil.
- Invalidación de la caché de usuario entre instancias: ADR-003, al decidir correr ≥ 2 instancias.
