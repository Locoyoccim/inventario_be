# Reporte de cierre de auditoría — NexoMesa (backend y despliegue)

Fecha: 2026-10-11 · Alcance: backend `inventario_be` y su despliegue en Railway; el front `GastronomyHub` solo en lo que lo toca (CI, build, aviso de privacidad).
Método: lectura del código y de la base, ejecución de las pruebas y de los scripts de auditoría, y **mutaciones deliberadas** (se rompe a propósito una garantía y se comprueba que alguna prueba falle). Un hallazgo sin evidencia se reporta como hipótesis.

## 1. Resumen ejecutivo

**Veredicto: listo para el piloto de pruebas de un mes, con riesgos aceptados y documentados (sección 6).** No se encontró corrupción de datos ni fuga entre empresas.

- La auditoría pidió verificar cuatro cosas «antes de producción» (identidad del correo, aviso de privacidad, respaldo restaurable, monitoreo) y cuatro fases adicionales (aislamiento, integridad de operaciones, CI, recuperación). Las pruebas nuevas **demostraron tres defectos reales de integridad** (AUD-F1, F2 y F3), con arreglo propuesto y verificado, dejaron a la vista una exposición de lecturas que el titular aceptó (AUD-F4) y confirmaron que una de las premisas de la auditoría era incorrecta (AUD-003).
- Los tres riesgos principales que quedan abiertos son: (1) lecturas sensibles abiertas a cualquier miembro de una empresa (aceptado por el titular), (2) no hay runbook de recuperación ni RTO medido, y el RPO es de 24 horas (aceptado durante el mes de pruebas), (3) dos comprobaciones de producción que exigen sesión (atributos de la cookie y tiempo real) siguen sin hacerse.
- **Estado de los arreglos:** seis PRs del backend abiertos y sin fusionar al momento de escribir esto (#21, de documentación, y #22 a #26). Hasta que se fusionen, `main` no contiene los arreglos.

## 2. Alcance

**Revisado:** unicidad e identidad del correo; aislamiento entre empresas (150 rutas) y permisos por ruta; sesiones y tokens; concurrencia en inventario, compras, producción, finanzas y cola de impresión; CI y dependencias de ambos repositorios; respaldo, restauración y monitoreo en producción; aviso de privacidad.

**No revisado en esta ronda** (para que nadie lo dé por cubierto):
- Pruebas de carga y rendimiento (sin objetivo operativo definido).
- Prueba de penetración externa y revisión del front más allá de typecheck, lint, pruebas, build y CI.
- Búsqueda de secretos en el historial de git (se hizo una rotación de claves tras un incidente de pegado en un chat; no una revisión del historial).
- `npm run audit:tenant` sobre **datos de producción** (solo se corrió sobre la base local).
- Concurrencia de las rutas de POS más allá de las que ya tenían pruebas previas (cobro, abrir mesa, corte, idempotencia).

## 3. Resultados de herramientas

| Comando | Resultado |
|---|---|
| Backend `npm run test:local` (CI: base limpia, rol `gh_app`, guardia de omitidas) sobre `main` | 872 de 872, 0 omitidas, 0 canceladas |
| Mismo comando por rama (cada una desde `main`, medido localmente) | #23: 880/880 · #24: 881/881 · #25: 876/876 · #26: 875/875 |
| Backend `npm audit --omit=dev` | 0 vulnerabilidades |
| Backend `npm run lint` y `format:check` | limpios |
| `npm run audit:tenant` (base local, solo lectura) | 107 relaciones revisadas, «Sin contaminación entre empresas» |
| Front `typecheck`, `lint`, `npm test` | limpios; 249 de 249 |
| Front `npm run build` | OK con `VITE_API_SAME_ORIGIN=true`; sin esa variable falla a propósito |
| Front `npm audit` | 0 vulnerabilidades |
| CI del front en el PR #22 (documentos legales) | 4 de 4 checks en verde (auditoría de dependencias, formato, front y e2e, según el workflow) |
| CI del backend en el PR #23 | 3 de 3 checks en verde (verificado en GitHub) |

Nota de honestidad: las ramas se midieron por separado; **la suma de todas no se ha corrido junta** hasta que se fusionen. El CI de `main` lo hará. En #22, #24, #25 y #26 no confirmé aún el estado de CI en GitHub.

## 4. Hallazgos

### AUD-003 — Unicidad global del correo · **Cerrado** (premisa de la auditoría incorrecta)
- Fase: Datos · Estado: **Verificado** · Severidad: Baja (solo faltaban pruebas)
- Afirmación auditada: «053 no crea un índice único global». Es cierto de la migración 053 aislada, pero el índice global lo crea la migración 021 (`usuarios_email_unique ON usuarios (email) WHERE email IS NOT NULL`); la 053 añade el `CHECK` de normalización para que ese índice compare lo mismo que el login.
- Evidencia: consulta a `pg_indexes` y `pg_constraint` en la base de pruebas **y en producción** (Railway, 2026-10-11): índice `UNIQUE (email) WHERE email IS NOT NULL` y `CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> ''))`, idénticos.
- Propuesta de la auditoría descartada: una migración nueva con un índice global duplicaría el existente. No se creó.
- Pruebas añadidas (PR #22): el índice se lee del catálogo (debe ser uno solo, global y parcial); 8 altas simultáneas con el mismo correo y distinta capitalización dan una sola 201, el resto 409, sin 500 ni cuentas a medias. Mutaciones (sin índice, índice por empresa): ambas se detectan.
- Riesgo del cambio: bajo (solo pruebas).

### AUD-F1 — Interbloqueo al confirmar producciones · **Corregido en PR #23 (sin fusionar)**
- Fase: Dominio/Datos · Estado: **Verificado** · Severidad: **Media**
- Ubicación: `src/modules/produccion/produccion.repository.js` (`confirmar`).
- Evidencia: dos peticiones con las mismas recetas en orden opuesto y sin insumos en común → `deadlock detected` y respuesta 500 (3 de 3 corridas; ~16–21 s en la prueba por la espera). La transacción se revierte: no hay datos corruptos.
- Por qué importa: dos cajeros produciendo a la vez pueden recibir un error sin motivo aparente.
- Arreglo: bloquear al inicio, ordenados por id, los inventarios de todas las recetas de la petición. La prueba pasa 3 de 3 y baja a ~0.2 s.
- Riesgo del cambio: bajo-medio (cambia el orden de bloqueos de una operación de inventario; cubierto por 8 pruebas nuevas y la suite).

### AUD-F2 — Doble anulación de un gasto o ingreso · **Corregido en PR #25 (sin fusionar)**
- Fase: Datos · Estado: **Verificado** · Severidad: **Baja**
- Ubicación: `src/modules/finanzas/finanzas.repository.js` (`anularGasto`, `anularIngreso`).
- Evidencia: 6 anulaciones simultáneas del mismo registro se confirmaron las 6, y cada una pisó el motivo y el autor de la anterior. Los totales no se corrompen (el indicador es idempotente), pero se pierde la trazabilidad de quién anuló y por qué.
- Arreglo: `UPDATE … WHERE anulado = false` y 409 para la perdedora.
- Riesgo del cambio: bajo.

### AUD-F3 — Resultado de impresión pisado → ticket duplicado · **Corregido en PR #26 (sin fusionar)**
- Fase: Datos/Dominio · Estado: **Verificado** · Severidad: **Media**
- Ubicación: `src/modules/pos/pos.impresion.repository.js` (`resultado`).
- Evidencia: `SELECT … FOR UPDATE` fuera de una transacción: el bloqueo se soltaba al instante. En una sonda de 300 corridas, 77 veces un reporte de fallo posterior devolvió a `PENDIENTE` un trabajo ya impreso, y se reimprimiría el ticket o la comanda. La prueba lo reproduce de forma determinista.
- Cuándo ocurre: con reportes contradictorios del mismo trabajo (por ejemplo, vence el plazo de 30 s y lo toma otro agente).
- Arreglo: lectura y escrituras del resultado en una sola transacción.
- Riesgo del cambio: medio (toca la cola de impresión del POS). Probado con las pruebas nuevas, las de afinidad, descarte y aislamiento sin JWT (26 de 26), y la suite completa.

### AUD-F4 — Lecturas sensibles abiertas a cualquier miembro de la empresa · **Aceptado por el titular (2026-10-11)**
- Fase: Seguridad · Estado: **Verificado** · Severidad: **Media** (lectura, intra-empresa)
- Evidencia: con un rol sin permisos, 117 de 150 rutas de empresa responden 403; las 33 restantes son 32 lecturas y un cálculo sin efectos (`POST /recetas/preview`). **Ninguna escritura queda abierta.** Entre las lecturas abiertas hay datos sensibles: `GET /usuarios/:empresa` (correo, código de ingreso, rol, admin/dueño, estado del PIN de todo el personal), gastos e ingresos, reportes de inventario, actividad, historial y consumo, y el kardex.
- Decisión: el titular **no restringe** estas lecturas por ahora. Queda fijada en `test/integration/permisos-matriz.test.js` con una lista explícita y su motivo: una ruta nueva sin guardia, o una abierta que se proteja, hace fallar la prueba.
- Reevaluar si el piloto se abre a más personal. Propuesta futura: exigir admin en la lista de usuarios y crear permisos de «ver finanzas» y «ver reportes».
- Riesgo del cambio si se decide cerrar: medio (cambia contrato de API y permisos).

### AUD-F5 — Operativo sin rol hereda permisos · Informativo
- Un Operativo sin `role_id` recibe `compras.crear`, `conteos.crear`, `produccion.crear`, `gastos.crear` e `ingresos.crear` (`PERMISOS_SIN_ROL` en `src/middlewares/activeUser.js`). Es intencional (compatibilidad con usuarios antiguos); conviene saberlo al dar de alta personal sin rol.

### AUD-F6 — El algoritmo del JWT no está fijado explícitamente · Bajo · **Hipótesis acotada**
- `jwt.verify(token, secret)` no pasa `algorithms`. Con una clave de texto la librería solo acepta HMAC y la prueba de `alg: none` confirma que se rechaza, así que no hay explotación demostrada. Fijar `algorithms: ["HS256"]` es endurecimiento de bajo riesgo. No se aplicó.

### Sesiones y tokens · **Sin hallazgos**
- Token caducado, firmado con otra clave, sin firma (`alg: none`), con la firma recortada, con el cuerpo manipulado y basura dan 401 por `Authorization` y por cookie, sin datos; con control de que el mismo token bueno entra (PR #24). Mutaciones (ignorar la caducidad, no verificar la firma): se detectan (1 y 5 pruebas fallan).

### AUD-011 — Aviso de privacidad · **Cerrado salvo un dato pendiente**
- El aviso describe la IP, los identificadores, los plazos (IP en bitácora 12 meses con purga diaria, logs del servidor 7 días) y los proveedores reales (Railway, Cloudflare R2, UptimeRobot). Revisión del abogado hecha (confirmada por el titular el 2026-10-10); documentos renombrados a NexoMesa y sin avisos de borrador (front PR #22, fusionado).
- Pendiente: agregar el proveedor de correo (Aviso y Acuerdo) cuando exista dominio. Hoy el servicio no envía correos, así que no hay un tercero que reciba esos datos.
- Los Términos describen el POS propio y aclaran que no procesa pagos ni emite CFDI.

### AUD-004 — Respaldo restaurable · **Cerrado con evidencia (2026-10-09)**
- El cron `respaldo` hizo `pg_dump` 18 de producción y subió el archivo a Cloudflare R2; se descargó y se restauró en una base temporal separada: 54 migraciones y los mismos conteos (1 empresa, 1 usuario). Las llaves de R2 se rotaron tras un pegado accidental en un chat.
- Brecha asociada: ver AUD-F7.

### AUD-007 — Monitoreo, variables y secuencia de migraciones · **Cerrado, con dos comprobaciones pendientes**
- Evidencia (2026-10-09): `/health` y `/health/ready` 200 por la URL pública; sin «AVISO» ni «Configuración insegura» al arrancar; CORS sin `Access-Control-Allow-Origin` para un origen ajeno; `/api/auth/me` sin sesión da 401; la IP real aparece en los logs con `TRUST_PROXY_HOPS=3` (con 2 aparecía la IP del borde) y un `X-Forwarded-For` falso no la altera; migraciones 001–054 aplicadas; un monitor de prueba contra una URL 404 cayó en ~5 minutos y UptimeRobot envió el correo.
- **Pendiente:** los atributos de la cookie de sesión (`HttpOnly; Secure; SameSite=Lax`) y que el tiempo real (SSE) de cocina no se corte pasando por dos proxies. Exigen iniciar sesión; el comando está en `docs/DESPLIEGUE.md` §4.

### AUD-F7 — Recuperación: sin runbook ni RTO medido · **Aceptado y pospuesto**
- Fase: Datos/Operación · Estado: **Verificado** · Severidad: **Media**
- Evidencia: `docs/RESPALDOS.md` documenta restaurar ante un desastre y recomienda respaldar antes de migrar (`npm run backup && npm run migrate`), pero **no hay** procedimiento de rollback de aplicación, ni estrategia para una migración destructiva, ni tiempo de recuperación medido. Las migraciones son solo hacia adelante (`db/migrate.js` no tiene «down»; solo revierte la que falla a medias). El respaldo previo a migrar es manual.
- RPO actual: hasta ~24 horas (respaldo diario).
- Decisión del titular (2026-10-11): se mantiene el RPO de 24 horas durante el mes de pruebas y se pospone el runbook y la restauración cronometrada. Revisión: **~2026-11-10**.

### AUD-F8 — Rendimiento sin objetivo · **Riesgo aceptado, no medido**
- No se ejecutaron pruebas de carga: no hay objetivo (usuarios simultáneos, mesas, órdenes por minuto). Límite conocido: una sola instancia de API (ADR-003) y pool de 10 conexiones.

## 5. Criterios de aceptación, uno por uno

| Criterio de la auditoría | Estado |
|---|---|
| AUD-003: mismo correo en dos empresas, altas simultáneas, cambio de correo, normalización, acceso compartido, producción coherente | **Cumplido** (PR #22 por fusionar; producción verificada) |
| Fase 2.1 Un usuario de A no lee ni modifica datos de B cambiando ids | **Cumplido** (177 rutas más los 2 endpoints de salud clasificados; 403 en cada una de las de empresa; control positivo) |
| Fase 2.2 Ninguna ruta crítica opera sin sus permisos | **Cumplido para escrituras**; lecturas abiertas aceptadas (AUD-F4) |
| Fase 2.3 La contaminación entre empresas se detecta en las pruebas | **Cumplido** (`audit-tenant`, `aislamiento-*`) |
| Fase 2.4 Acceso compartido solo dentro de las empresas autorizadas; retirarlo corta la sesión | **Cumplido** (`acceso-multiempresa.test.js`: conceder, operar, retirar y desactivar) |
| Fase 2.5 Sin pruebas omitidas ni fallos ocultos por reintentos | **Cumplido** (0 omitidas; sin reintentos configurados; una guardia hace fallar la corrida si algo se omite) |
| Fase 3 Operaciones críticas preservan invariantes con duplicados y concurrencia, verificando la base | **Cumplido** para POS (previo), inventario, compras, producción, finanzas e impresión; 3 defectos hallados y corregidos (AUD-F1, F2, F3) |
| Fase 4 Checks obligatorios en verde, sin omitidas, sin vulnerabilidades altas o críticas | **Cumplido**; rendimiento: ver AUD-F8 |
| Fase 5 Respaldo restaurable, ruta documentada de recuperación, objetivos de recuperación conocidos, smoke tests | **Parcial**: respaldo restaurable verificado; runbook, RTO y smoke tests formales pospuestos (AUD-F7) |

## 6. Riesgos aceptados y decisiones del titular

| Decisión | Fecha | Revisión |
|---|---|---|
| Lecturas sensibles abiertas a cualquier miembro de la empresa (AUD-F4) | 2026-10-11 | Al abrir el piloto a más personal |
| RPO de 24 horas; runbook y RTO pospuestos (AUD-F7) | 2026-10-11 | ~2026-11-10 |
| Sin pruebas de carga hasta tener un objetivo operativo (AUD-F8) | 2026-10-11 | Al definir el objetivo |
| Operativo sin rol con permisos heredados (AUD-F5) | — | Informativo |

## 7. Plan de acción

1. **Fusionar** los PRs #21 (registro de la migración del catálogo) y #22 a #26 (cada uno parte de `main` y no depende de los demás) y confirmar que el CI de `main` queda en verde con todo junto. Hasta entonces, los arreglos de AUD-F1, F2 y F3 no están en producción.
2. **Comprobar en producción** la cookie de sesión y el tiempo real de cocina (necesita la sesión de quien tenga la contraseña del maestro).
3. **Correr `audit:tenant`** contra una copia de la base de producción, ahora que hay datos de la empresa Aroma.
4. **~2026-11-10:** escribir el runbook de recuperación (rollback de aplicación, migraciones destructivas, pasos y tiempos) y cronometrar una restauración para fijar el RTO.
5. **Con el dominio:** conectar el dominio, configurar el correo transaccional y agregar su proveedor al Aviso y al Acuerdo.
6. Opcional, bajo riesgo: fijar `algorithms` en la verificación del JWT (AUD-F6).

## 8. Lo que está bien y conviene conservar

- Aislamiento multiempresa con un catálogo de rutas generado del router real: una ruta nueva sin clasificar rompe el CI.
- Rol de base de datos de mínimo privilegio para la app, con guardia de arranque, y roles separados para migrar.
- Bloqueos `FOR UPDATE` bien puestos en inventario, compras y producción (las mutaciones que los quitan se detectan), y `SKIP LOCKED` en la cola de impresión.
- Guardia de CI que invalida la corrida si alguna prueba se omite.
- Respaldos fuera de Railway (otra cuenta y otro proveedor), con restauración ya ensayada, y alertas probadas.
