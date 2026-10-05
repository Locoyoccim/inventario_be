# Referencia de API — Inventario Backend

API REST multiempresa (Node/Express + PostgreSQL) para café-restaurante: productos, inventario, recetas y preparaciones, producción, compras, ventas, conteo físico y reportes.

## Información general

| Concepto | Valor |
| --- | --- |
| URL base (local) | `http://localhost:4000` |
| Prefijo | `/api` |
| Formato | JSON (`Content-Type: application/json` en todo POST/PUT) |
| Autenticación | **JWT** (7 días) en todo `/api/*` salvo `login`, `setup` y `logout`. Dos vías: header `Authorization: Bearer <token>` (Postman/integraciones) o cookie httpOnly `gh_session` (front web). Con cookie, POST/PUT/DELETE exigen el header `X-Requested-With` (anti-CSRF) o responden `403` |
| Multiempresa | cada recurso cuelga de `:empresa_id`; el token debe corresponder a esa empresa o responde `403` |

### Seguridad de borde
Cabeceras de seguridad (`helmet`), body limitado a 100 KB, y **rate limiting**: 10 req/min por IP en `login`/`setup` (anti fuerza bruta) y 300 req/min por IP en el resto de `/api` → responde `429` al excederlo.

### Healthcheck
`GET /health` (público, sin token) → `{ "status": "ok", "uptime": ..., "ts": "..." }` — liveness, no toca la BD.
`GET /health/ready` → readiness: hace `SELECT 1` contra la BD; `200` si responde, `503` si no.

### CORS
Por defecto permite todos los orígenes (desarrollo). En producción, define `CORS_ORIGINS` (lista separada por comas) para restringir a los dominios del front.

### Sobre de respuesta

Éxito:
```json
{ "success": true, "data": { } }
```
Listados paginados:
```json
{ "success": true, "data": [ ], "pagination": { "limit": 50, "offset": 0, "total": 120 } }
```
Error:
```json
{ "success": false, "error": { "message": "..." } }
```
Error de validación (zod) → `400` con detalle por campo:
```json
{ "success": false, "error": { "message": "Datos inválidos", "detalles": [ { "campo": "cantidad", "mensaje": "cantidad debe ser > 0" } ] } }
```

### Códigos

| Código | Significado |
| --- | --- |
| `200` / `201` | OK / creado |
| `400` | Datos inválidos o regla de negocio (stock insuficiente, elaborado no se compra, etc.) |
| `401` | Falta token o es inválido/expiró |
| `403` | El token no corresponde a la empresa/rol de la URL |
| `404` | No encontrado (o no pertenece a la empresa) |
| `409` | Conflicto (ej. día de ventas ya importado) |
| `500` | Error interno |

### Paginación y filtros

Listados aceptan `?limit=` (default 50, máx 200) y `?offset=`. Filtros específicos por recurso se indican en cada sección.

---

## Autenticación

### `POST /api/auth/setup`
Crea el **primer** usuario (owner/admin). Solo funciona si no existe ningún usuario. Requiere que la empresa y el rol ya existan.
```json
{ "empresa_id": 4, "nombre": "Carlos", "email": "carlos@aroma.mx", "password": "min6chars", "codigo_ingreso": "0001", "puesto": "Dueño", "role_id": 1 }
```
Respuesta: `{ "token": "...", "user": { } }`.

### `GET /api/auth/invitacion/:token` · `POST /api/auth/invitacion`
Activación de cuenta por **enlace de invitación** (públicas; las autoriza el token de un solo uso). `GET` valida el enlace y devuelve `{ nombre, email, empresa }` (`404` si ya se usó, venció o no existe). `POST { "token": "...", "password": "mín. 8 caracteres" }` define la contraseña, consume el enlace en la misma operación atómica, revoca sesiones anteriores y deja `must_change_password = false`; después se inicia sesión con `POST /auth/login`. Con el mismo límite de intentos que el login.

### `POST /api/auth/login`
```json
{ "email": "carlos@aroma.mx", "password": "..." }
```
Respuesta: `{ "token": "...", "user": { } }` y además `Set-Cookie: gh_session=<token>; HttpOnly; SameSite=Lax`. El token dura **7 días** (config `JWT_EXPIRES`). El front web ignora el `token` del body y usa la cookie (enviar peticiones con `credentials: include` / `withCredentials`).

El correo se compara sin distinguir mayúsculas ni espacios (`lower(trim(email))`), y se guarda en minúsculas al crear usuarios. Si un usuario no puede entrar: `LOGIN_PASSWORD='clave' npm run diagnosticar:login -- correo@dominio.com`.

### `POST /api/auth/logout`
Público. Borra la cookie de **este** dispositivo → `{ "success": true, "data": null }`. No revoca otros tokens.

### `POST /api/auth/logout-all`
Requiere sesión. Sube la `token_version` del usuario → **revoca todas** sus sesiones vigentes (cookie y Bearer) y borra la cookie actual. La revocación surte efecto a más tardar en 1 minuto (caché). Un admin puede forzar el cierre de otro usuario con `forzar_cierre_sesion: true` en el `PUT` de usuarios.

### `GET /api/auth/me`
Con Bearer o cookie → devuelve el perfil actual desde BD: `{ id, nombre, email, empresa_id, is_admin, is_owner }` (mismo formato que `user` en login). Pasa por `requireActiveUser`: `401` si el usuario ya no existe, está desactivado o su sesión fue revocada (`logout-all`).

### Ingreso con PIN en equipos registrados
El personal operativo (mesero, cajero, cocina) entra con un **PIN de 4 a 6 dígitos** desde un **equipo registrado** (el celular o la tablet del local). El PIN solo sirve ahí: sin la cookie del equipo no hay ingreso con PIN. **No aplica a dueño ni administradores**, que siguen con correo y contraseña.

Flujo: un Admin registra el equipo y obtiene un **código de un solo uso** (`XXXX-XXXX`, vale 15 min, sin 0/O/1/I; solo se guarda su hash) → se escribe en el equipo → el servidor entrega la cookie `gh_device` (httpOnly, `Path=/api/auth`, 400 días; solo se guarda el hash del token) → en ese equipo el personal toca su nombre y teclea su PIN.

- `POST /api/auth/dispositivo/registrar` — público (con límite de intentos y header `X-Requested-With`). `{ "codigo": "ABCD-2345" }` → `{ "nombre" }` + `Set-Cookie: gh_device`. El código se consume al usarse (`400` si no existe, ya se usó o venció).
- `GET /api/auth/dispositivo/personal` — con la cookie del equipo: `{ dispositivo: { id, nombre }, personal: [{ id, nombre, puesto }] }` (solo activos con PIN y que no son administradores). `401` si el equipo no está registrado o fue revocado (y borra la cookie).
- `POST /api/auth/pin` — con la cookie del equipo y `X-Requested-With`. `{ "usuario_id", "pin" }` → `{ user }` + `Set-Cookie: gh_session` **de turno** (`PIN_SESSION_EXPIRES`, 12 h por defecto; el token no viaja en el body). Un PIN incorrecto, una persona sin PIN, un administrador o alguien de otra empresa responden igual: `401 PIN incorrecto`.

**Bloqueos** (contadores en `pin_fallos`): 5 fallos del mismo usuario en el mismo equipo (ventana de 15 min), 15 del equipo o 30 de la IP → `429` con `details.espera_seg` (5 min desde el último intento, aunque el PIN sea el bueno). 10 fallos de un usuario en una hora (en cualquier equipo) lo **bloquean** (`pin_bloqueado`): solo un Admin lo quita.

**Límites de una sesión de PIN:** el JWT lleva `pin: true` y el equipo (`disp`). No es Admin aunque la persona lo sea (`requireAdmin`, `requirePermiso` y plataforma la rechazan con `403`); **no autoriza** descuentos/cancelaciones por sí misma (el supervisor lo confirma con correo y contraseña en el cuerpo); y deja de valer al revocar el equipo, quitar el PIN, desactivar a la persona o ascenderla a Admin (`401`, hasta 1 min por la caché).

Administración *(Admin; nunca desde una sesión de PIN)*:
- `GET /api/dispositivos/:empresa_id` — equipos con `estado` (`PENDIENTE`, `CODIGO_VENCIDO`, `ACTIVO`, `ACTIVO_CON_CODIGO`, `REVOCADO`), `ultimo_uso`. Nunca salen hashes.
- `POST /api/dispositivos/:empresa_id` — `{ "nombre" }` → `{ dispositivo, codigo, vigencia_min }` (el código solo se ve aquí). `PUT .../:id` renombra.
- `POST /api/dispositivos/:empresa_id/:id/codigo` — código nuevo para re-registrar el equipo (cambio de teléfono); al canjearlo, el token anterior deja de valer.
- `POST /api/dispositivos/:empresa_id/:id/revocar` — no borra: queda como `REVOCADO` y sus sesiones de PIN dejan de valer.
- `PUT /api/usuarios/:empresa_id/:id/pin` — `{ "pin" }` (4–6 dígitos; se rechazan `0000` y secuencias como `1234`). `400` para administradores. Se guarda `bcrypt(HMAC(pimienta, id:pin))`; la pimienta es `PIN_PEPPER` (o `JWT_SECRET`). Limpia el bloqueo.
- `DELETE /api/usuarios/:empresa_id/:id/pin` — quita el PIN y **cierra las sesiones** de esa persona. `POST .../pin/desbloquear` quita el bloqueo y los contadores.
- `GET /api/usuarios/:empresa_id` agrega `tiene_pin` y `pin_bloqueado` (nunca el hash).

En despliegue con el front en otro dominio, la cookie del equipo usa las mismas opciones que la de sesión (`COOKIE_SAMESITE=none` + HTTPS).

### Roles: Admin vs Operativo (+ permisos granulares)
Cada usuario es **Admin** (`is_owner` o `is_admin` = true) u **Operativo** (lo demás).
- **Admin**: acceso total.
- **Operativo**: siempre puede **leer** todo (productos, inventario, recetas, reportes, categorías). Para **crear** (compras, conteos, producción, gastos, ingresos) depende de su **rol** (`usuarios.role_id` → catálogo en `GET /api/roles/:empresa_id`): cada rol trae una lista de `permisos` (claves `compras.crear`, `conteos.crear`, `produccion.crear`, `gastos.crear`, `ingresos.crear`). Sin `role_id` asignado, un Operativo se trata como el rol "Operativo completo" (todas esas claves) — compatibilidad con usuarios creados antes de que existiera este sistema. Falta de permiso para la acción → `403 "Tu rol no tiene permiso para esta acción"`.
- Un Operativo NO puede crear/editar productos, recetas, costos, proveedores, usuarios ni categorías, sin importar su rol → `403`.
- Un usuario **desactivado** (`activo: false`) no puede iniciar sesión (`403`) y sus tokens vigentes dejan de servir (`401`, a más tardar en 1 minuto).

Un Admin crea usuarios Operativo con `POST /api/usuarios/:empresa_id` incluyendo `email` + `password`, `is_admin`/`is_owner` en `false` y, opcionalmente, `role_id`.

### `GET /api/roles/:empresa_id`
Catálogo global de roles (no cuelga realmente de la empresa; el `:empresa_id` es solo para reusar el guard de sesión). Cualquier usuario autenticado puede leerlo — lo usa el formulario de Usuarios para el selector de rol.
```json
{ "success": true, "data": [
  { "id": 4, "nombre": "Operativo completo", "descripcion": "...", "clave": "completo",
    "permisos": ["compras.crear", "conteos.crear", "produccion.crear", "gastos.crear", "ingresos.crear"] },
  { "id": 5, "nombre": "Compras y almacén", "clave": "compras", "permisos": ["compras.crear", "conteos.crear"] },
  { "id": 6, "nombre": "Producción", "clave": "produccion", "permisos": ["produccion.crear", "conteos.crear"] },
  { "id": 7, "nombre": "Finanzas", "clave": "finanzas", "permisos": ["gastos.crear", "ingresos.crear"] },
  { "id": 8, "nombre": "Mesero (próximamente)", "clave": "mesero", "permisos": [] }
] }
```
El rol **Mesero** no tiene ningún permiso hoy: es un lugar reservado para cuando exista un POS propio con operación de piso (mesero abre/cierra mesas y toma órdenes); por ahora un usuario con ese rol solo puede leer.

---

## Empresas
El alta, baja y datos generales de las empresas son del usuario maestro de plataforma (`/api/platform/empresas`). Cada empresa solo consulta y ajusta su propia configuración:
- `GET /api/empresas/:id/configuracion` — `{ iva_pct, precios_incluyen_iva, food_cost_objetivo, zona_horaria }` (cualquier usuario de la empresa).
- `PUT /api/empresas/:id/configuracion` *(owner/admin)* — campos opcionales (`iva_pct`, `precios_incluyen_iva`, `food_cost_objetivo`, `zona_horaria`). La **zona horaria** (nombre IANA, por defecto `America/Mexico_City`, validada contra Postgres) decide qué día es «hoy» y a qué día pertenece cada movimiento en Finanzas, Reportes y Kardex, sin depender de la zona del servidor (migración 038). Cambiar el IVA de la empresa **no** modifica recetas existentes; solo aplica a las nuevas. Con `?aplicar_a_recetas=true` propaga el IVA a **todas** las recetas y responde `recetas_actualizadas`. (migración 018)

## Plataforma (administración de tenants)

Nivel aparte de Admin/Operativo: exige `usuarios.is_platform_admin = true` (`requirePlatformAdmin`), independiente de a qué empresa pertenezca ese usuario maestro. No cuelga de `:empresa_id` (vive en `/api/platform/empresas`, no en `/api/empresas/:empresa_id`), porque el guard de empresa compararía contra la empresa del propio maestro, no la que se administra.

- `GET /api/platform/empresas` — lista todas las empresas (todos los tenants).
- `POST /api/platform/empresas` — crea una empresa nueva **y** su usuario dueño (Owner) en una transacción, en sustitución de `/auth/setup` (que solo sirve una vez, para el primer usuario de toda la base):
```json
{ "empresa": { "nombre": "Café Aroma", "titular?": "...", "telefono?": "...", "email?": "...", "domicilio?": "..." },
  "owner": { "nombre": "Carlos", "email": "carlos@aroma.mx", "password?": "min6chars", "codigo_ingreso": "0001", "puesto?": "Dueño" } }
```
  **Invitación por correo (recomendado):** si se omite `owner.password`, el Owner nace sin contraseña (no puede entrar) y recibe un correo con un enlace de **un solo uso, válido 7 días**, para definir la suya; quien da de alta la empresa nunca conoce ni transmite una contraseña. La respuesta incluye `invitacion: { enviada, expira_at, motivo?, url? }`; si el correo no salió (SMTP sin configurar o con error) `enviada` es `false` y `url` trae el enlace para entregarlo a mano. Con `password` se conserva el flujo anterior (contraseña temporal + cambio obligatorio). Configuración SMTP en `.env.example` (`SMTP_URL` o `SMTP_*`, `MAIL_FROM`, `APP_URL`). Migración 041 (`usuario_tokens`: solo se guarda el hash del token).
- `POST /api/platform/empresas/:id/reenviar-invitacion` — nuevo enlace para un Owner que aún no activa su cuenta (anula el anterior). `409` si ya definió su contraseña. `GET /platform/empresas` trae `owner_invitacion_pendiente`.
- `PATCH /api/platform/empresas/:id/estado` — `{ "activo": true|false }`. Una empresa desactivada bloquea el login de todos sus usuarios (`401 "La empresa fue desactivada..."`, vía `requireActiveUser`).
- `POST /api/platform/empresas/:id/resetear-password` — `{ "password": "min6chars" }`. Fija directamente la contraseña del dueño de esa empresa, para soporte cuando pierde acceso.

## Usuarios
- `GET /api/usuarios/:empresa_id`
- Cada usuario trae `email`, `activo`, `role_id` y `rol`.
- `POST /api/usuarios/:empresa_id` *(Admin)* — `{ "nombre", "codigo_ingreso", "puesto?", "role_id?", "is_admin?", "email?", "password?" }`
- `PUT /api/usuarios/:empresa_id/:id` *(Admin)* — `nombre` y `codigo_ingreso` requeridos; el resto es opcional y **lo que no se envía se conserva**: `puesto`, `is_admin`, `role_id`, `email`, `password` (se hashea), `activo` y `forzar_cierre_sesion` (revoca las sesiones vigentes del usuario). `is_owner` no se cambia por API. Nadie puede desactivarse ni quitarse Admin a sí mismo, y al dueño no se le desactiva ni se le quita Admin (`400`).

## Proveedores
Cada proveedor trae `activo`. El borrado es **lógico** (soft-delete): nunca se elimina físicamente, para conservar el historial de compras y productos.
- `GET /api/proveedores/:empresa_id` — solo **activos** por defecto; `?incluir_inactivos=true` incluye los desactivados. 
- `POST /api/proveedores/:empresa_id` — `{ "nombre", "telefono?", "email?", "domicilio?" }`
- `PUT /api/proveedores/:empresa_id/:id` — mismos campos; acepta `"activo": true` para **reactivar** un proveedor desactivado.
- `DELETE /api/proveedores/:empresa_id/:id` — **desactiva** (`activo=false`) y devuelve el proveedor.
- `DELETE /api/proveedores/:empresa_id/:id?definitivo=true` *(Admin)* — **borrado físico**. Solo procede si el proveedor no tiene referencias (productos, compras ni gastos); si las tiene → `409` con `details` = conteos `{ productos, compras, gastos }`. Para eliminar uno con historial, primero **fusiónalo**.
- `POST /api/proveedores/:empresa_id/:id/fusionar` *(Admin)* — `{ "destino_id": <id> }`. Reasigna productos, compras y gastos del proveedor origen al destino (misma empresa) y luego **desactiva** el origen. Transaccional.
- `GET /api/proveedores/:empresa_id/:id/resumen` *(Admin)* — historial del proveedor: `{ ultimas_compras: [...10], total_30_dias, total_90_dias, ultimo_precio_por_producto: [{ producto_id, producto, costo_unitario, fecha }], referencias: { productos, compras, gastos }, puede_eliminar }`. `ultimas_compras`, los totales y `ultimo_precio_por_producto` **excluyen compras anuladas**. `referencias` cuenta productos (activos e inactivos), compras (incluidas anuladas) y gastos (incluidos anulados); `puede_eliminar` es `true` solo si las tres son 0 — es exactamente la condición que usa `DELETE ?definitivo=true` para el `409`.
- Un producto o compra **no** puede usar un proveedor inactivo (o de otra empresa) → `400`. Un producto que ya referencia un proveedor desactivado sigue mostrando su nombre y puede editarse mientras no cambie de proveedor.

## Categorías (lista compartida, administrable)
Una sola lista por empresa para productos y recetas; el front la usa para el selector. Productos y recetas guardan el **nombre** de la categoría (columna de texto), no el id. Nombre único por empresa **sin distinguir mayúsculas** (índice único `(empresa_id, lower(nombre))`, migración 017). Cada categoría trae `tipo` ∈ `PRODUCTO | RECETA | AMBAS`.
- `GET /api/categorias/:empresa_id[?tipo=PRODUCTO|RECETA]` — lista (cualquier usuario autenticado). Con `tipo=PRODUCTO` devuelve las `PRODUCTO` **y** las `AMBAS` (igual con `RECETA`); sin `tipo`, todas.
- `POST /api/categorias/:empresa_id` *(Admin)* — `{ "nombre": "Bebidas", "tipo?": "AMBAS" }` (`tipo` opcional, default `AMBAS`). Nombre repetido (case-insensitive) → `409`.
- `PUT /api/categorias/:empresa_id/:id` *(Admin)* — `{ "nombre?": "Bebidas Frías", "tipo?": "PRODUCTO" }` (al menos uno; lo que no se envía se conserva). **Renombra en cascada** en una transacción: actualiza el nombre en `categorias`, en `productos` y en `recetas` que usaban el nombre viejo. Respuesta: la categoría + `productos_actualizados` + `recetas_actualizadas`. Si el nuevo nombre ya existe (case-insensitive) → `409` y no cambia nada.
- `DELETE /api/categorias/:empresa_id/:id[?reasignar_a=<id>]` *(Admin)*:
  - Sin uso → se borra.
  - En uso y sin `reasignar_a` → `409` con `details: { productos, recetas }`.
  - Con `reasignar_a` (otra categoría de la misma empresa) → mueve productos y recetas al nombre destino y borra la categoría, todo en una transacción; responde `productos_movidos` y `recetas_movidas`.
  - `reasignar_a` igual a la misma categoría, o de otra empresa/inexistente → `400`.

Al crear una **preparación**, se asegura que la categoría `Preparación` (tipo `PRODUCTO`) exista en la lista, que es la que recibe el producto elaborado. La migración 017 además da de alta los nombres que ya usaban productos/recetas y no estaban en la lista (con su `tipo` según el uso), y fusiona variantes que solo difieren en mayúsculas.

**Integridad referencial (migración 028):** un trigger de BD en `productos` y `recetas` exige, en cada `INSERT`/`UPDATE` de la columna `categoria`, que el valor ya exista en `categorias` para esa empresa (vacío/`NULL` se permite). No es una FK (se mantuvo texto para no romper los consumidores existentes), pero cierra el hueco que antes permitía guardar una categoría huérfana vía datos legacy o cualquier endpoint que escribiera `productos`/`recetas` sin pasar por `/categorias`: el trigger lanza `foreign_key_violation`, que `errorHandler` mapea a `400 "Referencia inválida: el recurso relacionado no existe"`.

---

## Productos

Campos: `producto, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion`. `unidad_medida` se **normaliza** a un catálogo canónico (`g, kg, ml, l, pieza, porcion`, migración 019): POST/PUT aceptan variantes comunes (`gr`, `Gramos`, `kilos`, `Litros`, `pza`, `unidades`, `porción`…) y las guardan en su forma canónica; una unidad no reconocida → `400`. El sistema **no convierte** entre unidades: la `cantidad` de la receta se asume en la misma unidad del producto. El `costo_unitario` es **calculado** (`costo_presentacion / cantidad_presentacion`) con 4 decimales; `costo_presentacion` admite hasta 4 decimales (migración 011), de modo que insumos con presentación chica (p.ej. `cantidad_presentacion=1`) conservan el costo real (ej. `0.0123`) sin redondear a `0.01`. El stock vive en inventario y **solo** cambia por `/movimientos`, `/compras`, `/produccion` o `/conteos`.
Campo opcional **`compra_al_producir`** (boolean, default `false`, migración 016): marca insumos perecederos que se compran justo al producir; nunca alertan por mínimo (ver *Reportes*) y su necesidad aparece en las sugerencias de producción. Solo aplica a insumos comprados; en productos elaborados se ignora.

Campo opcional **`stock_maximo`** (migración 023): sin dato, "por reponer" sigue sugiriendo solo hasta el mínimo; con dato, sugiere completar hasta el máximo. Si se envía, debe ser mayor que `stock_minimo` → `400`. Se edita también junto con `stock_minimo` vía `PATCH /api/productos/:empresa_id/:id/limites` (la única forma de tocar límites en un producto elaborado, cuyo resto de campos vienen de su receta).

Campo opcional **`precio_venta`** (migración 025): solo para productos que se venden **tal cual**, sin receta (mapeados `INSUMO` en el POS) — habilita que esas ventas cuenten en el "ingreso esperado" de Finanzas (antes solo usaba `recetas.precio_venta`, así que esas líneas aportaban $0 al esperado aunque sí vendieran).

### `GET /api/productos/:empresa_id`
Filtros: `?q=<nombre>` (búsqueda parcial), `?categoria=<exacta>`, `?bajo_minimo=true` (stock < mínimo), `?incluir_inactivos=true` (incluye desactivados). Cada fila trae `proveedor_id`, `proveedor` (nombre), `stock_actual`, `stock_minimo`, `es_elaborado`, `compra_al_producir`, `merma_pct` y `costo_util` (= `costo_unitario / (1 − merma_pct/100)`, 4 decimales; `costo_unitario` sigue siendo el costo **bruto** de compra) y `activo`. El detalle (`GET /:id`) incluye los mismos campos.

### `POST /api/productos/:empresa_id`
```json
{ "producto": "Tomate Verde", "unidad_medida": "g", "proveedor_id": 1, "categoria": "Insumo",
  "cantidad_presentacion": 1000, "costo_presentacion": 25, "stock_actual": 5000, "stock_minimo": 1000,
  "compra_al_producir": false, "merma_pct": 0 }
```

### `PUT /api/productos/:empresa_id/:id`
Mismos campos (sin `stock_actual`) + opcionales `"activo": true|false`, `"compra_al_producir": true|false` y `"merma_pct"` (0–89.99; si no se envía, se conserva). En elaborados se ignora. Un producto **elaborado** (preparación) no se edita aquí → `400`.
Si cambia el costo **o la merma**, las recetas que usan el producto se recalculan en la misma transacción (ver *Cascada de costos*); la respuesta trae `recetas_actualizadas`.

### `DELETE /api/productos/:empresa_id/:id`
**Soft-delete**: marca `activo=false` (conserva el historial). No borra físicamente. Reactivar con `PUT ... {"activo": true}`.

### `GET /api/productos/:empresa_id/:id/uso`
Dónde se usa el producto, para decidir antes de desactivarlo. Respuesta: `{ recetas: [{ id, nombre }], mapeos_pos: [{ id, nombre_pos }] }` — recetas que lo incluyen como ingrediente y mapeos POS tipo `INSUMO` que apuntan a él. Producto inexistente en la empresa → `404`.

## Movimientos de inventario
- `GET /api/movimientos/:empresa_id` — **kardex de la empresa**, paginado. Filtros: `?producto_id=`, `?tipo=COMPRA|VENTA|MERMA|AJUSTE|DEVOLUCION|PRODUCCION`, `?desde=YYYY-MM-DD`, `?hasta=YYYY-MM-DD`, `?sentido=entrada|salida`. Cada fila trae `producto`, `unidad_medida` y `usuario`.
- `GET /api/productos/:empresa_id/:id/movimientos` — historial paginado del producto
- `POST /api/productos/:empresa_id/:id/movimientos` — ajuste manual de stock
```json
{ "tipo_movimiento": "COMPRA|VENTA|MERMA|AJUSTE|DEVOLUCION|PRODUCCION", "cantidad": 10,
  "motivo?": "texto", "costo_unitario?": 0.03 }
```
`AJUSTE` usa el signo de `cantidad`; los demás tienen dirección fija. El `usuario_id` se toma de la sesión. Para compras reales usa `/compras` (actualiza costo).

`costo_unitario` del movimiento se guarda con 4 decimales (migración 009); los movimientos anteriores a esa migración conservan el valor redondeado a 2 decimales.

---

## Recetas

Campos: `nombre, categoria, precio_venta, costo_produccion?, proteccion_pct?, ingredientes[]`, y opcionales `iva_pct` y `precio_incluye_iva` (al crear, si no vienen, se toman de la empresa). `costo_total` se calcula con la fórmula única `(insumos + producción) × (1 + protección%)`, usando el **costo útil** de cada insumo (con merma). Los precios se capturan con **IVA incluido** por defecto; `margen`, `precio_neto` y `costo_pct` se calculan sobre el precio **sin IVA**.

**Campos derivados** (en listado, detalle y `preview`): `precio_neto` (precio sin IVA), `iva_monto` (`precio_venta − precio_neto`), `costo_pct` (`costo_total / precio_neto × 100`), `margen` (sobre neto), `utilidad` (`precio_neto − costo_total`) y `precio_sugerido` (`costo_total / (food_cost_objetivo/100)`, más IVA si aplica, redondeado al múltiplo de $5 más cercano). Ej.: precio 110, IVA 16%, costo 35 → `precio_neto` 94.83, `iva_monto` 15.17, `costo_pct` 36.91, `margen` 63.09, `utilidad` 59.83, `precio_sugerido` 135.

### `GET /api/recetas/:empresa_id`
Filtros: `?q=`, `?categoria=`, `?incluir_inactivos=true`.

### `GET /api/recetas/:empresa_id/ventas?desde=&hasta=` *(Admin)*
Mezcla de ventas por receta y **costo % ponderado** (ingeniería de menú), agregando las cuentas cobradas en el POS **y el historial de ventas ya importadas del CSV de Toteat (`venta_diaria` + `venta_diaria_detalle`, que se conserva; la importación se retiró)** (`pos_cuentas` `PAGADA` + `pos_cuenta_items` no cancelados). En los renglones del POS `ingreso` es lo cobrado (con descuento; la cortesía suma unidades pero no ingreso) y el IVA sigue el precio congelado del renglón. Por defecto, los últimos 30 días hasta ayer. Valida `desde <= hasta` y rango ≤ 366 días (mismos mensajes que `finanzas/resumen`; `400` con `details`). Solo cuenta líneas `tipo='RECETA'`; los días revertidos ya no existen (CASCADE). El `costo_teorico` usa el **costo vigente** de la receta (no el histórico). Por receta: `unidades`, `ingreso` (precio capturado, normalmente con IVA), `ingreso_neto` (sin IVA cuando `precio_incluye_iva`), `costo_teorico` = `unidades × costo_total`, `costo_pct` = `costo_teorico / ingreso_neto × 100` (null si neto 0) y `utilidad`. Ordenadas por `unidades` desc (incluye inactivas si se vendieron). `totales.costo_pct` es el ponderado (Σcosto_teorico / Σingreso_neto). `sin_receta: { lineas, unidades }` = líneas `SIN_MAPEO`/`INSUMO` que quedan fuera. Sin días importados → `recetas: []`, totales en 0, `costo_pct: null`, `dias_importados: 0`. `dias_importados` cuenta los días con ventas (CSV o POS); `dias_pos` cuántos de ellos se cobraron en el POS. `sin_receta` incluye también los renglones del POS que son producto (no receta).
```json
{ "periodo": { "desde": "2026-08-27", "hasta": "2026-09-25" }, "dias_importados": 24, "dias_pos": 9,
  "recetas": [ { "receta_id": 12, "nombre": "Latte", "categoria": "Bebidas", "es_preparacion": false, "activo": true,
    "unidades": 310, "ingreso": 15500.00, "ingreso_neto": 13362.07, "costo_teorico": 1550.00, "costo_pct": 11.60, "utilidad": 11812.07 } ],
  "totales": { "unidades": 820, "ingreso": 52000.00, "ingreso_neto": 44827.59, "costo_teorico": 12100.00, "costo_pct": 26.99, "utilidad": 32727.59 },
  "sin_receta": { "lineas": 14, "unidades": 37 } }
```

### `POST /api/recetas/:empresa_id/preview`
Costeo **sin guardar**:
```json
{ "precio_venta": 85, "costo_produccion": 0, "proteccion_pct": 0,
  "ingredientes": [ { "producto_id": 7, "cantidad": 200 } ] }
```

### `POST /api/recetas/:empresa_id`
Receta normal:
```json
{ "nombre": "Chilaquiles Verdes", "categoria": "Platillos", "precio_venta": 85,
  "ingredientes": [ { "producto_id": 7, "cantidad": 200 }, { "producto_id": 8, "cantidad": 120 } ] }
```
Preparación / subreceta (además se crea un **producto elaborado** en inventario):
```json
{ "nombre": "Salsa Verde", "categoria": "Salsas", "precio_venta": 0,
  "es_preparacion": true, "rendimiento": 1000, "unidad": "ml", "stock_minimo": 500,
  "ingredientes": [ { "producto_id": 1, "cantidad": 700 }, { "producto_id": 2, "cantidad": 100 } ] }
```

### `PUT /api/recetas/:empresa_id/:id` · `DELETE /api/recetas/:empresa_id/:id`
Body: `nombre`, `categoria`, `precio_venta`, opcionales `activo`, `costo_produccion`, `proteccion_pct`, **`rendimiento`** y **`ingredientes`**.
- Sin `ingredientes`: solo se actualiza el encabezado (el escandallo no se toca).
- Con `ingredientes: [{ producto_id, cantidad }]` (mínimo 1): **guardado atómico** — encabezado + escandallo completo se reemplazan en UNA transacción con los costos vigentes; si algo falla (p. ej. un producto inexistente) no cambia nada → `400`. La respuesta incluye `ingredientes` con los renglones nuevos (los `id` de renglón cambian).
- Una preparación no puede llevarse a sí misma como ingrediente → `400`. `es_preparacion` y `unidad` no se editan aquí.
- **`rendimiento`** (solo en preparaciones, `es_preparacion = true`): editable. Al cambiarlo, el backend recalcula `costo_total` de esa receta (el costo por unidad del elaborado cambia porque se reparte entre más o menos unidades) y dispara la misma **cascada de costos** hacia cualquier receta que use ese elaborado como ingrediente. La respuesta agrega `recetas_actualizadas` (cuántas recetas recibieron el recosteo).

### `GET /api/recetas/:receta_id/detalle`
Ingredientes de la receta (`producto`, `unidad_medida`, `cantidad`, `costo_unitario`, `costo_final`). El guard de `:receta_id` exige que la receta sea de la empresa del token (`403` si no, `404` si no existe). Los ingredientes se editan con `PUT /api/recetas/:empresa_id/:id` (`ingredientes[]` reemplaza el escandallo completo).

### Cascada de costos
Cuando cambia el costo o la **merma** de un insumo (compra, `PUT` de producto) o el costo de una preparación (su receta cambió), se refresca `receta_detalle.costo_unitario` (= **costo útil**) de las recetas que lo usan y se recalcula su `costo_total`; si esas recetas son preparaciones, la cascada continúa (con protección contra ciclos).

## Producción (preparaciones)

Cada confirmación crea una fila en `produccion` (cabecera de un **lote**: fecha, usuario, estado de anulación) y todos sus movimientos (insumos consumidos + elaborado recibido, de todas las recetas de esa corrida) quedan referenciados a ese id — igual que compra/conteo, permite anular esa corrida puntual sin tocar otras producciones de las mismas recetas.

### `GET /api/produccion/:empresa_id/sugerencias`
Preparaciones bajo mínimo con lotes sugeridos. Cada sugerencia trae `insumos_requeridos` (compat) y **`insumos`**: `[{ producto_id, producto, unidad, requerido, disponible, faltante, compra_al_producir }]` para los lotes sugeridos, con `requerido`/`disponible`/`faltante` en **bruto** (lo que hay que comprar; `requerido = neto / (1 − merma/100)`). Esta vista es de **un solo nivel**: si un insumo es a su vez una subreceta, no explora más abajo (para eso está `plan`).

### `GET /api/produccion/:empresa_id/plan/:receta_id?lotes=N`
**Planificación con subrecetas anidadas.** Si alguno de los insumos de la receta objetivo es a su vez una preparación (subreceta) y no hay stock suficiente, resuelve la cascada completa (anidamiento arbitrario, con detección de ciclos — `400` si hay uno) y dice cuántos lotes de **cada** subreceta producir **antes**, en orden de dependencia, más lo que falta comprar al final. Solo lectura: no mueve inventario ni crea registros.
```json
{ "receta_id": 23, "nombre": "Pastel de Salsa Verde", "lotes": 2, "cantidad_a_producir": 4,
  "pasos_previos": [
    { "receta_id": 23, "producto_elaborado_id": 55, "nombre": "Salsa Verde", "unidad": "ml", "cantidad_a_producir": 1200, "lotes": 2 }
  ],
  "insumos": [ { "producto_id": 173, "producto": "Tomate Verde", "unidad": "g", "requerido": 1400, "disponible": 0, "faltante": 1400, "compra_al_producir": false } ]
}
```
`pasos_previos` ya viene ordenado: una subreceta que es insumo de otra sale primero. `insumos` son los insumos **crudos** finales (no elaborados), una vez cubierta toda la cascada.

### `POST /api/produccion/:empresa_id/confirmar` *(Operativo con permiso `produccion.crear`, o Admin)*
Consume insumos y suma stock de la preparación (movimientos `PRODUCCION`, transacción atómica, todas las líneas bajo UNA cabecera):
```json
{ "producciones": [ { "receta_id": 1, "lotes": 1, "cantidad_real?": 980 } ] }
```
**Rendimiento real vs. teórico:** si se pesó/contó el lote terminado y `cantidad_real` difiere de lo que la receta predice (`rendimiento × lotes`), se ajusta la existencia del elaborado a lo real con un movimiento `AJUSTE` bajo la misma cabecera — así anular revierte exactamente lo que de verdad se movió. Respuesta por receta: `cantidad_producida` (= `cantidad_real` si se envió, si no el teórico), `cantidad_teorica` y `stock_elaborado_nuevo`.

### `GET /api/produccion/:empresa_id` (historial, paginado) · `GET /api/produccion/:empresa_id/:id` (cabecera + líneas)

### `POST /api/produccion/:empresa_id/:id/anular` *(Admin)*
`{ "motivo": "..." }`. Revierte el lote completo: por cada producto, revierte el **neto** acumulado de sus movimientos (insumos consumidos vuelven, elaborado recibido se descuenta) con un `AJUSTE` de signo contrario. `409` si alguna reversa dejaría stock negativo (p. ej. ya se vendió parte de lo producido) y no se anula nada. Idempotente: reintentar sobre un lote ya anulado → `409`.

## Compras (entrada de mercancía + costo)

Suma stock (`COMPRA`) y actualiza el costo del producto al **precio de la última compra** (último costo — no promedio: una compra nueva se vuelve el costo de **todo** el stock existente de ese insumo, y cascada a las recetas que lo usan). Un producto elaborado no se compra → `400`.

Toda compra tiene un `estado`: `RECIBIDA` (default, compra directa — el flujo de siempre) o `PEDIDO` (dos fases: pedir, luego confirmar recepción).

### `POST /api/compras/:empresa_id` (compra directa, `estado=RECIBIDA`)
```json
{ "fecha?": "2026-09-21", "proveedor_id?": 1, "referencia?": "F-001",
  "lineas": [ { "producto_id": 1, "cantidad": 2000, "costo_total": 60 } ] }
```
Cada línea acepta `costo_total` (lo pagado) **o** `costo_unitario`. Aplica el movimiento de stock y la cascada de costos de inmediato.
Respuesta: `{ compra, lineas, recetas_actualizadas }` — las recetas que usan esos insumos se recalculan en la misma transacción (*Cascada de costos*).

Si alguna línea implica un cambio de costo de **40% o más** respecto al costo vigente del producto (p. ej. error de captura en cantidad o precio), responde `409` con el detalle en vez de aplicar la compra; reenviar la misma petición con `{ "confirmarCostoAtipico": true }` la fuerza.

### `POST /api/compras/:empresa_id/pedido` (crea un **pedido**, `estado=PEDIDO`)
Mismo body que la compra directa. **No** toca inventario ni costo — solo registra el encabezado y las líneas (`compra_detalle`) como intención de compra, para llevar registro de qué se pidió mientras no llega.

### `POST /api/compras/:empresa_id/:id/recibir` *(Operativo con permiso `compras.crear`, o Admin)*
Confirma la recepción de un pedido: aplica el mismo movimiento de stock, actualización de costo y cascada de recetas que una compra directa, usando las líneas ya registradas al crear el pedido. `{ "confirmarCostoAtipico?": true }` (mismo mecanismo que arriba). `409` si el pedido no existe en estado `PEDIDO` (ya recibido o anulado) — no se puede recibir dos veces.

### `GET /api/compras/:empresa_id` (historial, incluye `estado`) · `GET /api/compras/:empresa_id/:id` (encabezado + líneas)
En un pedido aún no recibido, las líneas vienen de `compra_detalle` (no hay movimientos todavía); una vez recibida, de `movimientosinventario` como siempre.

### `POST /api/compras/:empresa_id/:id/anular` *(Admin)* — `{ "motivo?": "..." }`
- Sobre una compra `RECIBIDA`: revierte con un movimiento `AJUSTE` negativo (`referencia_tipo=COMPRA_ANULADA`) el stock que había sumado y marca `anulado=true` (`anulado_at`, `anulado_por`, `motivo_anulacion`). `409` si al revertir alguna línea el stock quedaría **negativo** (no se anula nada). El costo del producto se **restaura** solo si esta compra fue la **última** que fijó su costo (si hubo compras posteriores, el costo vigente no se toca).
- Sobre un **pedido** (`estado=PEDIDO`) sin recibir: solo marca `anulado=true` (no hay movimientos que revertir — equivale a "cancelar pedido").
- Las compras anuladas se excluyen del libro de finanzas. Idempotente: reintentar sobre una compra ya anulada → `409`.

## Análisis del negocio *(solo Admin)*

Tres lecturas de lo **cobrado en el POS** dentro de un periodo. Todas aceptan `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` (por defecto, los últimos 30 días contados desde el «hoy» de la empresa; máximo 366 días; `400` si el rango es inválido) y cuelgan de `/api/analisis/:empresa_id`. Otro rol → `403`.

- `GET /menu` — **ingeniería de menú** (método de Kasavana y Smith). Por cada receta o producto vendido: `unidades`, `ventas_netas` (sin IVA, ya con descuentos y cortesías), `costo` (costo actual de la receta × unidades), `margen`, `margen_unitario`, `food_cost_pct`, `popularidad_pct` y `clase`: **estrella** (popular + margen alto), **popular** (vende mucho, deja poco), **oportunidad** (deja mucho, se pide poco) o **revisar**. *Popular* = su parte de las unidades llega al 70 % de lo que le tocaría en un reparto parejo (`referencias.popularidad_minima_pct`); *margen alto* = su margen por unidad iguala o supera el promedio del menú (`referencias.margen_unitario_promedio`). Un artículo sin costo (`sin_costo: true`) no se clasifica ni mueve los promedios. `precio_sugerido` aparece solo si su costo de alimentos hoy pasa el objetivo de la empresa (`empresas.food_cost_objetivo`): es el precio de lista que lo llevaría al objetivo. `suficiente: false` con menos de 4 artículos medibles. `sin_ventas` lista las recetas activas con precio que no se vendieron.
- `GET /consumo` — **costo teórico contra real por insumo**. `teorico_*` = movimientos `VENTA` menos las `DEVOLUCION` por anulación de ventas; `merma_*` = movimientos `MERMA` (incluye la de cancelaciones del POS); `diferencia_conteo_*` = ajustes de conteo físico con signo (negativo = faltante); `perdida_valor` = merma − diferencia de conteo (un sobrante la compensa); `desviacion_pct` = pérdida ÷ teórico; `nivel` = `ok | bajo | medio (≥5 %) | alto (≥10 %) | sin_ventas`. Un insumo sin conteo en el periodo trae `contado_en_periodo: false` (no se puede medir su faltante) y `totales.sin_conteo_*` lo suma. `serie` agrupa teórico y pérdida por semana (por mes si el rango pasa de 120 días). Los ajustes de compras anuladas no cuentan como pérdida; los ajustes manuales se reportan aparte (`ajuste_manual_valor`).
- `GET /fugas` — **control de fugas** a partir de `pos_autorizaciones`: totales y `por_tipo` (descuentos, cortesías, productos y cuentas cancelados, ventas anuladas; corregir un pago y quitar un descuento se cuentan pero **no suman dinero**), `por_usuario` (quien hizo la acción; si el supervisor la hizo directo, él), `por_autorizador` y los `recientes`. Cada persona trae `ventas` (cuentas cobradas donde fue mesero o cobró) y `pct_ventas`; `atipico: true` con al menos 3 eventos y un `pct_ventas` de 2 veces o más el del negocio. `merma_cancelaciones` suma lo cancelado «ya preparado».

## Conteo físico (varianza y reconciliación)

### `GET /api/conteos/:empresa_id/plantilla`
Productos con su stock teórico actual, para llenar el conteo.

### `POST /api/conteos/:empresa_id`
Calcula varianza vs. teórico y reconcilia el inventario con `AJUSTE` (transacción):
```json
{ "fecha?": "2026-09-21", "motivo?": "Corte semanal",
  "lineas": [ { "producto_id": 1, "stock_fisico": 4850, "stock_teorico_base?": 5000 } ] }
```
`stock_teorico_base` (opcional) es la existencia que el sistema tenía **al empezar a contar** (la de la plantilla). Con ella la varianza es `contado − base` y se aplica sobre la existencia actual: lo vendido o recibido mientras se contaba se conserva en lugar de aparecer como faltante o sobrante (si la existencia actual no alcanza para cubrirlo, queda en negativo en vez de perder el conteo). Sin base se compara contra la existencia del momento de guardar. `fecha` omitida = el día de hoy **en la zona horaria de la empresa**. Cada línea de `data.detalle` trae `movimiento_durante_conteo` (actual − base).
Respuesta: `data.detalle` (varianza y valor por producto) + `data.resumen` (`valor_merma`, `valor_sobrante`, `valor_neto`).
- `GET /api/conteos/:empresa_id` · `GET /api/conteos/:empresa_id/:id`
- `POST /api/conteos/:empresa_id/:id/anular` *(Admin)* — `{ "motivo": "..." }`. Revierte cada línea con un `AJUSTE` de signo contrario a la varianza aplicada (`referencia_tipo=CONTEO_ANULADO`) y marca `anulado=true`. Mismo patrón de bloqueo de fila e idempotencia que compras/producción: reintentar sobre un conteo ya anulado → `409`.

## Reportes (solo lectura)
- `GET /api/reportes/:empresa_id/estado?fecha=YYYY-MM-DD` — KPIs del día: valor de inventario, alertas, compras/consumo/mermas del día.
- `GET /api/reportes/:empresa_id/primeros-pasos` — avance de la puesta en marcha de una empresa nueva, deducido de sus datos: `{ pasos: [{ id, hecho, cantidad, requerido, ruta }], listo }` con los pasos `categorias`, `proveedores`, `insumos`, `recetas`, `mesas`, `impresora`, `equipo` y `primera_venta`. `listo` = los pasos `requerido` (categorías, insumos, recetas con precio y mesas) ya existen. Inicio lo muestra como guía.
- `GET /api/reportes/:empresa_id/pos?fecha=YYYY-MM-DD` — señal ligera para Inicio y el menú: `{ activo, turnos_sin_cerrar: [{ id, fecha_negocio, abierto_at, cajero }] }`. `activo` = la empresa ya abrió al menos una caja; `turnos_sin_cerrar` = cajas abiertas de días **anteriores** a `fecha` (default hoy): su venta aún no llega a Finanzas.
- `GET /api/reportes/:empresa_id/inventario` — valorización por producto + totales. Los productos con `compra_al_producir = true` nunca salen como `bajo_minimo`.
- `GET /api/reportes/:empresa_id/alertas` — bajo mínimo con acción (`comprar`/`producir`). Excluye los productos con `compra_al_producir = true`.
- `GET /api/reportes/:empresa_id/actividad?desde=&hasta=` — movimientos por tipo + merma (default últimos 30 días).
- `GET /api/reportes/:empresa_id/historial?desde=&hasta=&limit=&offset=` — feed paginado (`limit` default 50, máx 100) de eventos: registro y anulación de compras, conteos y producción, más reciente primero (default últimos 30 días). Cada fila: `{ tipo: "COMPRA"|"CONTEO"|"PRODUCCION", id, accion: "registrado"|"anulado", en, usuario_id, usuario, motivo, detalle, monto }` (UNION de las tres tablas; `monto` es `null` en producción). Pensado para la pantalla de Administración → Historial de actividad.
- `GET /api/reportes/:empresa_id/consumo?desde=&hasta=&limit=` — top productos consumidos por ventas.

---

## Finanzas (ingresos y gastos)

Todo cuelga de `/api/finanzas/:empresa_id/...`. Dinero `numeric(12,2)` y **> 0**; fechas `YYYY-MM-DD` reales y **no futuras** (`400`). Nada se borra: se **anula** (`anulado=true`). Las columnas de tipo fecha se devuelven como texto `YYYY-MM-DD`. Cada alta y anulación registra el `usuario_id` de la sesión. Listados con `?limit/offset` y sobre `{pagination}`.

**Visibilidad por rol:** Admin ve todo; **Operativo** solo crea y ve **lo que él capturó**; editar, anular, `resumen` y `movimientos` (libro) son **solo Admin** (`403` al Operativo).

### Categorías de gasto
- `GET /api/finanzas/:e/categorias-gasto` — activas por defecto; `?incluir_inactivas=true`.
- `POST /api/finanzas/:e/categorias-gasto` *(Admin)* — `{ "nombre": "Renta" }`. Únicas por empresa sin distinguir mayúsculas (`409` si se repite).
- `PUT /api/finanzas/:e/categorias-gasto/:id` *(Admin)* — `{ "nombre"?, "activo"? }`. No se borran; se desactivan.

Al crear una empresa se siembran: Renta, Luz, Agua, Gas, Sueldos, Mantenimiento, Publicidad, Impuestos y comisiones, Otros.

### Gastos
- `GET /api/finanzas/:e/gastos?desde&hasta&categoria_id&incluir_anulados&limit&offset`
- `POST /api/finanzas/:e/gastos` *(Admin y Operativo)*
```json
{ "fecha": "2026-09-21", "categoria_id": 3, "concepto": "Pago de renta", "monto": 12000.00,
  "metodo_pago": "TRANSFERENCIA", "proveedor_id": null, "nota": null }
```
Valida categoría activa y de la empresa, y proveedor (si viene) de la empresa y activo → `400`. `metodo_pago` ∈ `EFECTIVO|TARJETA|TRANSFERENCIA|OTRO`.
- `PUT /api/finanzas/:e/gastos/:id` *(Admin)* — mismos campos; `409` si está anulado.
- `POST /api/finanzas/:e/gastos/:id/anular` *(Admin)* — `{ "motivo": "..." }` → `anulado`, `anulado_at`, `anulado_por`.

### Ingresos
Se permiten varios por día (uno por método o varios conceptos).
- `GET /api/finanzas/:e/ingresos?desde&hasta&metodo_pago&incluir_anulados&limit&offset`
- `POST /api/finanzas/:e/ingresos` *(Admin y Operativo)* — `{ "fecha", "metodo_pago", "monto", "concepto"?, "nota"? }` (`concepto` default `"Venta del día"`).
> El cierre manual del día por lote (`/ingresos/lote`) se retiró: los ingresos del POS salen del corte de caja. Para sumar algo que no pasó por el POS se usa el ingreso individual (`POST /ingresos`).
- `PUT /api/finanzas/:e/ingresos/:id` *(Admin)*; `POST /api/finanzas/:e/ingresos/:id/anular` *(Admin)* `{ "motivo" }`. Los ingresos que genera el corte de caja traen `pos_turno_id` y **no se editan ni se anulan aquí** (**409**): se ajustan desde el POS (corregir pago o anular la cuenta), que mueven el corte y Finanzas a la vez. La fecha de un ingreso o gasto no puede ser futura **en la zona de la empresa**.

### Libro (vista unificada) *(Admin)*
- `GET /api/finanzas/:e/movimientos?desde&hasta&origen=INGRESO|GASTO|COMPRA&limit&offset`

UNION de ingresos, gastos (no anulados) y **compras** (lectura directa de la tabla `compra`), ordenado por fecha desc, id desc. Cada fila: `{ origen, id, fecha, concepto, categoria, metodo_pago, monto, proveedor, usuario }`. En compras: `categoria = "Compras de insumos"`, `metodo_pago = null`, `concepto = "Compra <referencia>"` (o `"Compra"` sin folio).

### Resumen *(Admin)*
- `GET /api/finanzas/:e/resumen?desde&hasta&agrupar=dia|semana|mes` — rango máximo 366 días, `desde <= hasta`, anulados excluidos. El resumen se calcula **sin IVA**: `ingresos` agrega `neto` (= `total / (1 + iva/100)` si la empresa captura con IVA) e `iva_estimado`; `food_cost_pct` y `resultado_operacion` se calculan sobre `ingresos.neto`; `flujo`, `ingreso_esperado` e `ingresos_comparables` siguen en **bruto**; la serie agrega `ingresos_neto`.
```json
{
  "periodo": { "desde": "2026-09-01", "hasta": "2026-09-30" },
  "ingresos": { "total": 42000, "neto": 36206.90, "iva_estimado": 5793.10, "por_metodo": [ { "metodo_pago": "EFECTIVO", "total": 25000 } ] },
  "gastos": { "compras": 18000, "extra": 9000, "total": 27000,
              "por_categoria": [ { "categoria_id": 3, "categoria": "Renta", "total": 12000 } ] },
  "flujo": 15000,
  "costo_ventas": 14000,
  "merma": 350,
  "resultado_operacion": 19000,
  "food_cost_pct": 33.33,
  "ingreso_esperado": 41250,
  "ingresos_comparables": 41000,
  "dias_sin_ingreso": ["2026-09-14"],
  "dias_turno_abierto": ["2026-09-30"],
  "serie": [ { "periodo": "2026-09-01", "ingresos": 1500, "ingresos_neto": 1293.10, "compras": 600, "gastos_extra": 0, "costo_ventas": 500 } ]
}
```
`costo_ventas` = Σ movimientos `VENTA`×costo − Σ `DEVOLUCION` de reversas (`referencia_tipo='VENTA_DIARIA'`). `resultado_operacion` = ingresos − costo_ventas − gastos.extra (las compras entran como inventario, no aquí). `food_cost_pct` = null si no hay ingresos. `ingreso_esperado` = Σ `venta_diaria_detalle.cantidad × precio_unitario` (snapshot de `recetas.precio_venta` al importar); null si ningún día del rango tiene detalle. `ingresos_comparables` = ingresos no anulados **solo** en las fechas del rango que tienen detalle (para comparar contra `ingreso_esperado`); null cuando `ingreso_esperado` es null. Los días importados antes de la migración 014 no tienen detalle. **Con el POS:** `ingreso_esperado` suma además `pos_cuentas.total` de las cuentas `PAGADA` del rango (lo cobrado con descuentos, sin propinas); `ingresos_comparables` incluye también las fechas con cuentas pagadas del POS (los ingresos los genera el corte al cerrar la caja); `dias_sin_ingreso` es solo de días importados por CSV; `dias_turno_abierto` lista las fechas con ventas cobradas en una caja que sigue abierta (aún no hay ingresos). `costo_ventas` ya resta las `DEVOLUCION` de `POS_CUENTA`.

---

## Punto de venta (mesas, cuentas y comandas)

POS propio: mesas, cuentas, comandas por área, precuenta, apertura de caja **cobro** (pagos mixtos, propina, descuento de inventario y cierre de mesa) **corte de caja** y **autorizaciones** (descuentos, cortesías, cancelaciones y anulación de una cuenta cobrada). Todas las rutas cuelgan de `/api/pos/:empresa_id`.

**Permisos** (en `roles.permisos`; Admin/Owner siempre pasan): `pos.ver` (mapa y consulta), `pos.ordenar` (abrir cuentas, productos, enviar comandas, cambiar/juntar/dividir), `pos.cobrar` (caja), `pos.autorizar` (cancelar lo ya enviado, ver la cola). `mesero` → ver+ordenar · `cajero` → ver+ordenar+cobrar · `supervisor` → todos · `hostess`/`recepcion` → solo ver. `GET /api/auth/me` y el login devuelven `permisos`.

### Configuración *(Admin; las lecturas piden `pos.ver`)*
- `GET|POST /areas` · `PUT /areas/:id` — áreas de preparación (`Cocina` predeterminada, `Barra`, `Sin comanda`; `imprime=false` = no genera comanda). Se siembran en el primer `GET`. El área predeterminada no se puede desactivar.
- `GET|POST /mesas` · `PUT /mesas/:id` — `{ nombre, zona?, capacidad?, orden?, activo? }`.
- `DELETE /mesas/:id` *(Admin)* — sin cuentas en su historial se **borra** (`accion: "eliminada"`); con historial de ventas solo se **desactiva** (`accion: "desactivada"`: las cuentas pasadas y los cortes no cambian); con una cuenta abierta → **409**.
- `GET /asignacion-areas` · `PUT /asignacion-areas/categoria/:id` · `PUT /asignacion-areas/:receta|producto/:id` — `{ "area_id": 2 | null }`. El área de un artículo se resuelve **artículo → categoría → predeterminada**.
- `GET /menu` — artículos vendibles (recetas activas no-preparación con precio > 0 y productos con `precio_venta`), con `area_id`, `area_origen`, precio e IVA, más `recetas_sin_precio`.

### Cuentas
- `GET /mapa` *(ver)* — `{ mesas: [{ ..., cuentas: [{ id, folio, total, por_enviar, mesero, abierta_at }] }], llevar: [...] }`.
- `POST /cuentas` *(ordenar)* — `{ tipo: "MESA"|"LLEVAR", mesa_id?, personas?, nombre_cliente? }`. Una mesa no se abre dos veces (**409**, también en solicitudes simultáneas). El folio es consecutivo por empresa.
- `GET /cuentas/:id` — cuenta con `items` y `totales { subtotal, descuento, iva, total }` (IVA incluido o sumado según el precio de cada renglón).
- `POST /cuentas/:id/items` — `{ lineas: [{ tipo: "RECETA"|"PRODUCTO", id, cantidad, notas? }] }`. Nombre, precio e IVA quedan **congelados** en el renglón. El mismo artículo sin notas y sin enviar se suma al renglón existente (tope 99).
- `PUT|DELETE /cuentas/:id/items/:itemId` — solo renglones `PENDIENTE` (**409** si ya se enviaron).
- `POST /cuentas/:id/items/:itemId/cancelar` *(autorizar)* — `{ motivo, merma? }`; deja el renglón `CANCELADO` con quién lo autorizó. Con `merma: true` («ya se preparó») los insumos salen del inventario como `MERMA` (`referencia_tipo = 'POS_MERMA'`, no se revierte al anular ventas) y suman a la merma de Finanzas; sin ella el inventario no se toca.
- `POST /cuentas/:id/enviar` — crea **una comanda por área** con lo pendiente, marca los renglones `ENVIADO` y encola la impresión. `{ comandas: [{ numero, area, renglones, impresion_estado }], sin_comanda, cuenta }`. Si el área no tiene impresora, esa impresión queda en `ERROR` (no se pierde).
- `POST /cuentas/:id/cambiar-mesa` `{ mesa_id }` (mesa libre) · `POST /cuentas/:id/juntar` `{ destino_id }` (la origen queda `UNIDA`) · `POST /cuentas/:id/dividir` `{ partes: [{ item_id, cantidad }] }` (crea una cuenta nueva en la misma mesa; no puede vaciar la original) · `POST /cuentas/:id/precuenta` (encola el estado de cuenta a la impresora de tickets) · `POST /cuentas/:id/cancelar` `{ motivo?, merma? }` (con productos enviados exige `pos.autorizar` y motivo; `merma: true` registra como merma todo lo enviado). Al juntar, las comandas de la cuenta origen continúan la numeración de la destino. Un renglón admite hasta 99 piezas: pasarse responde **400** en vez de recortar.
- **Idempotencia** (`Idempotency-Key`, 8–80 caracteres `[A-Za-z0-9_-]`): abrir cuenta, agregar renglones, enviar y cobrar aceptan este header. Si ya se hizo con esa llave se devuelve **la misma respuesta** (mismo status; header `Idempotent-Replay: true`) y no se repite el efecto: un reintento tras cortarse la señal, o un doble toque, no duplica renglones, comandas, folios ni cobros. La llave se reserva en la **misma transacción** que el efecto (`pos_idempotencia`), así que dos peticiones iguales a la vez producen un solo efecto. Es por usuario y empresa; la misma llave con otro cuerpo → `422`; los errores (4xx/5xx) no se guardan, así que tras uno la llave puede volver a intentarse; se conservan 48 h. Sin el header todo se comporta como siempre.
- **Pantalla de cocina (KDS), opcional.** Apagada por defecto (`PUT /empresas/:id/configuracion {usa_pantalla_cocina}`; `GET /impresion/estado` devuelve `pantalla_cocina`). Cada área elige papel, pantalla o ambos (`areas_preparacion.imprime` / `pantalla`, más `tiempo_objetivo_min`); `pantalla: true` en un área con la pantalla apagada → `409`. Con ella, `enviar` crea la comanda si el área imprime **o** muestra pantalla y solo genera trabajo de impresión si imprime (`impresion_id`/`impresion_estado` pueden venir `null`; cada comanda trae `pantalla`). Estados de comanda: `NUEVA → EN_PREPARACION → LISTA → ENTREGADA` (o `CANCELADA`); las de áreas sin pantalla nacen `ENTREGADA`. `GET /comandas/activas?area_id=` *(`pos.preparar`)* lista lo activo (nuevas, en preparación, listas de los últimos 10 min, canceladas de los últimos 3) con sus renglones —los cancelados después de enviar vienen marcados— y la hora del servidor (`ahora`). `POST /comandas/:id/estado {estado: EN_PREPARACION|LISTA|ENTREGADA}`: cocina (`pos.preparar`) prepara y deja lista, y puede **deshacer «lista»** durante 10 minutos; `ENTREGADA` también la marca quien tiene `pos.ordenar` (el mesero). Las transiciones están protegidas en SQL: repetir el mismo estado no es error, un salto o retroceso → `409`. `GET /cuentas/:id` trae `comandas[]` (área, número, estado, `pantalla`, `lista_at`, estado de su impresión) unidas por los renglones (no por `pos_comandas.cuenta_id`: dividir deja la comanda en la cuenta original) y `GET /mapa` agrega por cuenta `comandas_listas` y `comandas_sin_salida`. Cancelar un renglón marca la comanda como actualizada y, si ya no queda nada, `CANCELADA`; cancelar la cuenta cancela lo que siga por preparar. Apagar la pantalla pasa a `ENTREGADA` lo que seguía abierto y hace que las áreas «solo pantalla» vuelvan a imprimir. El rol «Cocina / Barra» (`cocina`: `pos.ver`, `pos.preparar`) y el supervisor traen el permiso `pos.preparar`.
- **Avisos en tiempo real (SSE).** `GET /api/pos/:empresa_id/eventos` *(`pos.ver`, cookie de sesión)* es un flujo `text/event-stream`. Los eventos son **avisos con ids** (nunca datos): `comanda.nueva {cuenta_id, mesero_id, areas}` (al confirmar el envío), `comanda.estado {comanda_id, estado, cuenta_id, mesero_id, area_id}`, `comanda.cancelada {cuenta_id}`, `impresion.error {impresion_id}` (una comanda agotó sus reintentos), `config` (se encendió/apagó la pantalla de cocina) y `resync` (pudo perderse algo: refrescar todo; también se manda al reconectar). Quien los recibe vuelve a pedir el estado, por eso perder uno no es grave y el polling sigue como respaldo. Internamente cada `pg_notify('pos_eventos', …)` se emite **dentro de la transacción** (sale al confirmar y no en un rollback; funciona con varias instancias del servidor), una conexión `LISTEN` propia por instancia (con reconexión y backoff) reparte a los clientes de cada empresa; latido cada 20 s, el flujo se cierra al vencer la sesión y como máximo 6 conexiones por usuario (se cierran las más viejas). Cabeceras `Cache-Control: no-cache, no-transform` y `X-Accel-Buffering: no`. Con el front en otro dominio la cookie debe permitir `SameSite=None; Secure` y el cliente usar `withCredentials`; la cadena de conexión a Postgres no puede pasar por un pooler en modo transacción (rompe `LISTEN`).
- **Opciones por producto, comensal y tiempos.** *Catálogo (Admin):* `GET /opciones` lista los grupos (`{ id, nombre, minimo, maximo, modificadores: [{ id, nombre, precio_extra, producto_id, producto, cantidad }], articulos: [{ tipo, id }] }`); `POST /opciones` y `PUT /opciones/:id` (mismo cuerpo: `nombre`, `minimo` ≥ 0, `maximo` ≥ 1 y ≤ nº de opciones, `modificadores[]`, `articulos[]`) crean o reemplazan el grupo —las opciones que ya no vienen se **desactivan, no se borran**—; `DELETE /opciones/:id` lo desactiva. Una opción puede cobrar un extra (`precio_extra`) y/o **descontar un insumo** al cobrar (`producto_id` + `cantidad` por pieza). `GET /menu` trae `grupos[]` (con sus opciones y extras) y, en cada artículo, `grupos: [ids]`. *Al tomar la orden:* cada línea de `POST /cuentas/:id/items` acepta `opciones: [ids]`, `comensal` (1–99) y `tiempo` (1–6): el servidor valida mínimos y máximos de cada grupo (`400` «Elige una opción de «Término»») y rechaza opciones que no son del artículo; el renglón guarda una **copia** de las opciones (`opciones[]`: grupo, nombre, extra e insumo) y su `precio_unitario` ya incluye los extras, así que cambiar el catálogo no altera cuentas tomadas. Renglones iguales (mismas opciones, comensal y tiempo, sin notas ni descuento) se suman; si algo cambia, van aparte. `PUT …/items/:itemId` permite corregir `comensal` y `tiempo` mientras esté pendiente. *Tiempos:* `POST /cuentas/:id/enviar {tiempo?}` envía lo pendiente de ese tiempo (1 por defecto; `400` «No hay productos del 2.º tiempo por enviar» si no hay); el 2.º, 3.º… se disparan aparte y **cobrar sigue bloqueado mientras quede algo pendiente**. La comanda impresa y la pantalla muestran opciones, comensal y «2.º TIEMPO»; precuenta y ticket listan las opciones. *Inventario:* al cobrar (y en la merma por cancelación) se descuenta el insumo de cada opción por pieza (con la merma del insumo), anular lo regresa. `dividir` conserva opciones, comensal y tiempo.
- `POST /cuentas/:id/cobrar` *(cobrar)* `{ pagos: [{ metodo: EFECTIVO|TARJETA|TRANSFERENCIA, monto, propina?, recibido?, referencia? }] }` — cobra en **una transacción**: guarda los pagos, descuenta el inventario (movimientos `VENTA` con `referencia_tipo = 'POS_CUENTA'`, `referencia_id` = id de la cuenta), cierra la cuenta (`PAGADA`, la mesa queda libre) y encola el ticket. Reglas: el cajero necesita turno abierto (**409** «Abre tu caja»); la cuenta no puede tener productos sin enviar (**400**); la suma de `monto` debe igualar el total exacto, la propina va aparte y no cuenta para el total; en efectivo `recibido` (opcional, por defecto exacto) debe cubrir `monto + propina` y el cambio es la diferencia; un pago puede ser solo propina (`monto: 0`); una cuenta de total 0 se cierra sin pagos. Una cuenta ya cobrada responde **409** (dos cajas a la vez: gana una). La venta queda en el turno y el día de negocio de quien cobra. Respuesta: `{ cambio, propina, ticket: { impresion_id, impresion_estado }, inventario: { negativos, errores, recetas_sin_escandallo }, cuenta }`. El inventario nunca bloquea el cobro: si una existencia queda negativa se reporta en `negativos`.
- **Autorización de supervisor.** Descuentos, cortesías, cancelar un renglón enviado, cancelar una cuenta con productos enviados y anular una cuenta cobrada requieren `pos.autorizar`. Quien no lo tiene puede mandar en el cuerpo `autorizacion: { email, password }` de un supervisor/Admin/Owner **de la misma empresa** (las mismas credenciales del login, se validan con bcrypt y no se guardan): esa persona queda como quien autorizó. Credenciales inválidas o de alguien sin permiso → **403**; sin credenciales ni permiso → **403**. Los intentos con credenciales se limitan a 15 por minuto por usuario. Todo queda en `pos_autorizaciones` (quién autorizó, quién lo pidió, importe y motivo).
- `POST /cuentas/:id/items/:itemId/descuento` · `POST /cuentas/:id/descuento` *(ordenar + autorización)* `{ tipo: PORCENTAJE|MONTO|CORTESIA|QUITAR, valor?, motivo, autorizacion? }` — solo en cuentas abiertas y renglones no cancelados. `PORCENTAJE` (0–100] y `MONTO` (máx. 2 decimales, sin pasar del importe) dan un descuento; `CORTESIA` cubre todo el renglón y **el inventario sí se descuenta al cobrar**; `QUITAR` regresa el precio de lista (sin motivo). A toda la cuenta, un monto se reparte en proporción al importe de cada renglón (y sustituye los descuentos previos). Una cuenta con total 0 se cobra con `pagos: []`.
- `POST /cuentas/:id/anular` *(cobrar + autorización)* `{ motivo, autorizacion? }` — solo cuentas `PAGADA` (**409** si ya está anulada o sigue abierta). En una transacción: regresa el inventario (`DEVOLUCION` al mismo costo, también la producción automática), marca los pagos como `anulado`, registra el dinero devuelto en `pos_devoluciones` en el turno de quien lo entrega (si hubo efectivo necesita caja abierta: **409** «Abre tu caja») y, si el turno de la venta ya cerró, descuenta lo devuelto de los ingresos que generó el corte (si llegan a 0 el ingreso se anula). El corte ya cerrado conserva sus cifras; la anulación se ve en `anuladas`. Para Finanzas, el costo de ventas ya considera las `DEVOLUCION` de `POS_CUENTA`.
- `POST /cuentas/:id/corregir-pago` *(cobrar + autorización)* `{ pagos: [{ metodo, monto, propina?, referencia? }], motivo, autorizacion? }` — corrige **cómo se pagó** una cuenta `PAGADA` (método, monto, propina o referencia) sin anularla. Los montos deben sumar exactamente el total de la cuenta (que no cambia, así que el inventario tampoco) y deben ser distintos a los actuales (**400**). **409** si la cuenta está abierta o anulada. En una transacción: reemplaza los pagos en el mismo turno, actualiza la propina de la cuenta, deja la copia del ticket con el pago correcto (`corregido: true`, sin abrir cajón), guarda cómo estaba y cómo quedó en `pos_correcciones_pago` y lo registra en `pos_autorizaciones` (`CORREGIR_PAGO`). **Si el corte del turno ya cerró**, el cierre original (`resumen`, esperado y diferencia) **no se modifica**: se ajustan los `ingresos` que mandó a Finanzas por el cambio de cada método (suben, bajan, se anulan si llegan a 0 o se crea el del método nuevo) y la corrección queda marcada `turno_cerrado`. Una anulación posterior descuenta lo ya corregido. La cuenta devuelve `correcciones` y `turno_cerrado`.
- `POST /cuentas/:id/ticket` *(ordenar)* — vuelve a imprimir el ticket de una cuenta cobrada; sale marcado como copia y sin abrir el cajón (**404** si la cuenta no tiene ticket).
- `GET /turnos/actual` *(ver)* (la caja abierta **propia**) · `GET /turnos/abierto` *(ver)* (la caja abierta del negocio, de quien sea: `{ id, cajero, fecha_negocio, fondo_inicial, abierto_at, es_mia }` o `null`) · `POST /turnos/abrir` *(cobrar)* `{ fondo_inicial }` — **solo puede haber una caja abierta por empresa** (índice único parcial, migración 050): si ya hay una, **409** con el nombre de quien la tiene (`Ya tienes una caja abierta` si es la propia). Cobrar exige la caja propia: si la tiene otra persona, el **409** de `/cobrar` lo dice; quien la abrió o un supervisor debe cerrarla antes. La migración 050 se detiene con un mensaje si ya hay empresas con varias cajas abiertas (no cierra nada sola).
- `POST /cuentas/:id/descartar` *(ordenar)* — salir de una cuenta sin enviar: borra los renglones `PENDIENTE` y, si la cuenta no tiene nada más (ni enviados, ni comandas, ni autorizaciones, ni cuentas ligadas por juntar/dividir), la **elimina** y deja la mesa libre; el folio se devuelve si era el último y una reservación que se había sentado vuelve a `confirmada`. Responde `{ eliminada, cuenta }` (`cuenta` = la cuenta ya sin lo pendiente cuando no se borra). **409** si la cuenta ya no está abierta. Además, `GET /mapa` libera por su cuenta las cuentas abiertas sin ningún renglón ni comanda que llevan más de 30 minutos sin actividad (app cerrada, sin señal…).
- `PATCH /cuentas/:id` *(ordenar)* `{ nombre_cliente?, personas? }` — nombre o referencia de la cuenta («Fam. Hernández») y número de personas; `""` quita el nombre. Solo cuentas abiertas (**409**). `POST /cuentas` también acepta `nombre_cliente` en cuentas de mesa. Las comandas, precuentas y tickets de una cuenta de mesa llevan `cliente` (ese nombre) en el payload de impresión; el agente ≥ 1.4.0 lo imprime en negrita antes de mesero y personas. `GET /mapa` y las cuentas traen `mesero_id` y `actualizada_at` (última actividad: producto, envío, descuento, nombre…; la mantienen triggers de la migración 036) junto a `abierta_at`.
- **Reservaciones.** `POST /cuentas` acepta `reservacion_id`: abrir la cuenta de una reservación la marca `sentada` (si estaba `pendiente`/`confirmada`) en la misma transacción y la deja ligada; una reservación con cuenta no cancelada → **409** («ya tiene la cuenta folio N»). `GET /api/reservaciones/:e` devuelve `cuenta_id`, `cuenta_folio` y `cuenta_estado` de esa cuenta (o `null`).
- **Corte de caja** *(cobrar; el cajero ve y cierra sus turnos, quien tiene `pos.autorizar` cualquiera, otro cajero **403**)*:
  - `GET /turnos` — turnos recientes con ventas, esperado, contado y diferencia.
  - `GET /turnos/:id/corte` — `{ turno, corte, ventas, anuladas, autorizaciones, cuentas_abiertas, es_ultimo_turno }` (`autorizaciones` = lo autorizado mientras duró el turno). Abierto = corte parcial. `corte` trae `por_metodo` (`cuentas`, `monto`, `propina`), `ventas` (sin propinas), `propinas`, `efectivo_cobrado` (ventas + propina en efectivo; el cambio ya salió; incluye ventas que luego se anularon), `devoluciones_efectivo` (efectivo devuelto por anulaciones desde este cajón) y `efectivo_esperado` = fondo + efectivo cobrado − devoluciones − propinas entregadas. Un turno cerrado devuelve su corte tal como se cerró.
  - `POST /turnos/:id/cerrar` `{ efectivo_contado, propinas_entregadas?, nota? }` — en una transacción: guarda esperado, contado y `diferencia` (contado − esperado: positivo sobra), cierra el turno, **genera los ingresos de Finanzas por método** (solo ventas, nunca propinas; `concepto` «Corte de caja · turno N», `pos_turno_id`, un ingreso por método y turno) y encola el corte para imprimir. Las propinas entregadas no pueden pasar de las cobradas (**400**). **La caja no se cierra con cuentas abiertas con productos** (una cuenta vacía no cuenta): responde **409** «No se puede cerrar la caja: hay N cuenta(s) abierta(s)…» con `details: { cuentas_abiertas, cuentas: [{ id, folio, etiqueta }] }`; no hay forma de forzarlo (un `forzar` enviado se ignora, ni siquiera un supervisor): primero se cobran o se cancelan. `GET /turnos/:id/corte` trae `cuentas_abiertas_detalle` (`id, folio, etiqueta, mesero, piezas`) para mostrarlas. Un turno cerrado responde **409**; los cobros que llegan durante el cierre esperan y, si el turno ya cerró, reciben «Abre tu caja».
  - Las respuestas de `GET /turnos/:id/corte` traen además `correcciones` (pagos corregidos de las ventas del turno, con `antes`/`despues`) y `ajustado`: con el turno **cerrado** y correcciones hechas después del cierre, `{ corte, diferencia }` ya sumados (ventas por método, efectivo esperado y diferencia contra lo contado); `null` si no hubo. El `corte` y la `diferencia` del turno siguen siendo los del cierre.
  - `GET /turnos` trae por turno cerrado `correcciones_posteriores` y `diferencia_ajustada` (contado − esperado ya con las correcciones de pago hechas después del cierre; `null` si no hubo). `diferencia` sigue siendo la del cierre original.
  - `POST /turnos/:id/corte/imprimir` — vuelve a imprimir el corte (parcial o definitivo). Un corte cerrado con correcciones de pago posteriores sale con las cifras ya ajustadas y una nota de cómo se cerró (`ajuste` en el payload; agente ≥ 1.5.0).

### Impresión
Las comandas, precuentas y tickets se encolan en `pos_impresiones` (el ticket lleva `abrir_cajon: true` si hubo efectivo); el **agente de impresión** (carpeta `print-agent/`) las toma y las imprime en cada impresora (red o USB).
- `GET|POST /impresoras` · `PUT /impresoras/:id` · `POST /impresoras/:id/prueba` *(Admin)* — `{ nombre, conexion: "RED"|"USB", ip?, puerto?, nombre_usb?, ancho: 58|80, area_id?, es_ticket? }`; una impresora atiende un área o es la de tickets.
- `GET|POST /agentes` · `PUT /agentes/:id` · `DELETE /agentes/:id` · `POST /agentes/:id/rotar-token` *(Admin)* (`DELETE` borra el agente: su token y su código dejan de servir; `404` si no existe en la empresa) — el token (`gh_agt_...`) se devuelve **una sola vez**; en la base solo queda su hash. El listado trae `equipo`, `emparejado_at`, `codigo_pendiente` y `desactualizado` (versión del agente < la publicada).
- **Emparejamiento por código** *(migración 048)*: `POST /agentes` devuelve además `codigo` (`XXXX-XXXX`, vale 15 min, un solo uso; solo se guarda su hash) y `POST /agentes/:id/codigo` *(Admin)* genera otro (el anterior sin usar deja de servir). El instalador lo canjea en `POST /api/agente/emparejar` (público, con límite de intentos) `{ codigo, equipo? }` → `{ servidor, token, zona_horaria, agente: { id, nombre } }`: el token es **nuevo** (reemplaza al anterior) y `servidor` sale de `PUBLIC_API_URL` o del host de la petición. `400` si el código no existe, ya se usó, venció o el agente está desactivado. `GET /agentes-info` *(Admin)* → `{ manifiesto, ultimo_error }` (versión publicada, enlace al instalador y último fallo de impresión).
- **Actualización automática del agente**: `GET /api/agente/version` (con el token del agente) → `{ manifiesto }` con `{ version, minima, url, sha256, instalador }` o `null`. Sale de las variables `AGENTE_ULTIMA_VERSION`, `AGENTE_URL_DESCARGA` (https), `AGENTE_SHA256`, `AGENTE_VERSION_MINIMA` y `AGENTE_INSTALADOR_URL`; sin URL https y hash válido no se publica la descarga. El agente descarga, verifica el hash, se reemplaza y reinicia; si la versión nueva no se mantiene viva, regresa a la anterior (ver `print-agent/instalador/LEEME.md`).
- `GET /impresion/estado` *(ver)* — `{ agentes_conectados, pendientes, errores, sin_impresora }` (conectado = contacto en los últimos 30 s; `sin_impresora` = trabajos del último día que no tenían impresora configurada).
- `POST /impresiones/:id/descartar` *(autorizar)* saca de la cola un trabajo que ya no hace falta (solo `PENDIENTE`, `ERROR` o `SIN_IMPRESORA`; `409` si ya se imprimió, lo está imprimiendo el agente o ya estaba descartado) y `POST /impresiones/descartar` `{ estados?: ["PENDIENTE"|"ERROR"|"SIN_IMPRESORA"] }` limpia varios de una vez → `{ descartados }`. **No borra la fila** (estado **`DESCARTADA`**, con `descartada_at`/`descartada_por`; migración 049): sale de la lista normal y de las alertas de «comanda sin salida», se consulta con `?estado=DESCARTADA` y se recupera con `reimprimir` (así un ticket descartado sigue pudiéndose reimprimir desde la cuenta).
- `GET /impresiones?estado=` *(autorizar)* · `POST /impresiones/:id/reimprimir` *(ordenar)*. Estados: `PENDIENTE`, `IMPRIMIENDO`, `IMPRESO`, `ERROR` (falló el agente) y **`SIN_IMPRESORA`** (la empresa no tiene impresora/agente para ese trabajo; no es una falla). Migración 040.
- **Impresión desde el navegador** (respaldo sin impresora): `GET /impresiones/:id` *(ordenar; un corte exige `pos.cobrar`)* → `{ id, tipo, estado, payload }` para dibujarlo en el cliente, y `POST /impresiones/:id/impreso-navegador` lo cierra como `IMPRESO` (solo desde `SIN_IMPRESORA` o `ERROR`; `409` si ya salió o está en la cola del agente).
- **Áreas de categorías nuevas**: al crear una categoría de bebidas («Bebidas», «Café», «Cervezas»…) queda asignada al área `Barra` (se siembran Cocina/Barra/Sin comanda si la empresa aún no las tiene); el resto va al área por defecto. Se puede cambiar en la asignación de áreas.
- **Agente** (`/api/agente/*`, autenticado con `Authorization: Bearer <token del agente>`, fuera de la sesión de usuario): `GET /impresiones/pendientes` toma los trabajos de forma atómica (uno no confirmado en 30 s se reintenta); `POST /impresiones/:id/resultado` `{ ok, error? }` — un fallo se reintenta con espera y a los 5 intentos queda en `ERROR`. Cada trabajo trae `reimpresiones` para distinguir una reimpresión manual de una re-entrega.

---

## Flujo end-to-end recomendado

1. `POST /api/auth/login` → token (o `/setup` la primera vez para el primer usuario de toda la base; luego, nuevas empresas se crean con `POST /api/platform/empresas`, que exige `is_platform_admin`).
2. `POST /api/proveedores/:e` y `POST /api/productos/:e` (insumos).
3. `POST /api/recetas/:e` con `es_preparacion` (salsa) → `POST /api/produccion/:e/confirmar` (producirla).
4. `POST /api/recetas/:e` del platillo usando la preparación como ingrediente.
5. `POST /api/pos/:e/turnos/abrir`, `POST /api/pos/:e/cuentas` … `/cobrar` (vender en el POS; el corte de caja lleva los ingresos a Finanzas).
6. `POST /api/conteos/:e` (contar) y `GET /api/reportes/:e/estado` (ver los números).
