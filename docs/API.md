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

### Roles: Admin vs Operativo (+ permisos granulares)
Cada usuario es **Admin** (`is_owner` o `is_admin` = true) u **Operativo** (lo demás).
- **Admin**: acceso total.
- **Operativo**: siempre puede **leer** todo (productos, inventario, recetas, reportes, categorías). Para **crear** (compras, conteos, producción, gastos, ingresos) depende de su **rol** (`usuarios.role_id` → catálogo en `GET /api/roles/:empresa_id`): cada rol trae una lista de `permisos` (claves `compras.crear`, `conteos.crear`, `produccion.crear`, `gastos.crear`, `ingresos.crear`). Sin `role_id` asignado, un Operativo se trata como el rol "Operativo completo" (todas esas claves) — compatibilidad con usuarios creados antes de que existiera este sistema. Falta de permiso para la acción → `403 "Tu rol no tiene permiso para esta acción"`.
- Un Operativo NO puede crear/editar productos, recetas, costos, proveedores, usuarios, pos-map ni categorías, ni revertir ventas, sin importar su rol → `403`.
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
- `GET /api/empresas` — lista (solo la propia)
- `GET /api/empresas/:id`
- `POST /api/empresas` *(plataforma)* — crea un tenant nuevo; exige el header `x-platform-token: <PLATFORM_TOKEN>` (sin esa variable, el endpoint queda cerrado). `{ "nombre", "titular?", "telefono?", "email?", "domicilio?" }`
- `PUT /api/empresas/:id` *(owner/admin)*
- `DELETE /api/empresas/:id` *(solo dueño)* — borra la empresa (en cascada); requiere `is_owner`.
- `GET /api/empresas/:id/configuracion` — `{ iva_pct, precios_incluyen_iva, food_cost_objetivo }` (cualquier usuario de la empresa).
- `PUT /api/empresas/:id/configuracion` *(owner/admin)* — campos opcionales (`iva_pct`, `precios_incluyen_iva`, `food_cost_objetivo`). Cambiar el IVA de la empresa **no** modifica recetas existentes; solo aplica a las nuevas. Con `?aplicar_a_recetas=true` propaga el IVA a **todas** las recetas y responde `recetas_actualizadas`. (migración 018)

## Plataforma (administración de tenants)

Nivel aparte de Admin/Operativo: exige `usuarios.is_platform_admin = true` (`requirePlatformAdmin`), independiente de a qué empresa pertenezca ese usuario maestro. No cuelga de `:empresa_id` (vive en `/api/platform/empresas`, no en `/api/empresas/:empresa_id`), porque el guard de empresa compararía contra la empresa del propio maestro, no la que se administra.

- `GET /api/platform/empresas` — lista todas las empresas (todos los tenants).
- `POST /api/platform/empresas` — crea una empresa nueva **y** su usuario dueño (Owner) en una transacción, en sustitución de `/auth/setup` (que solo sirve una vez, para el primer usuario de toda la base):
```json
{ "empresa": { "nombre": "Café Aroma", "titular?": "...", "telefono?": "...", "email?": "...", "domicilio?": "..." },
  "owner": { "nombre": "Carlos", "email": "carlos@aroma.mx", "password": "min6chars", "codigo_ingreso": "0001", "puesto?": "Dueño" } }
```
- `PATCH /api/platform/empresas/:id/estado` — `{ "activo": true|false }`. Una empresa desactivada bloquea el login de todos sus usuarios (`401 "La empresa fue desactivada..."`, vía `requireActiveUser`).
- `POST /api/platform/empresas/:id/resetear-password` — `{ "password": "min6chars" }`. Fija directamente la contraseña del dueño de esa empresa, para soporte cuando pierde acceso.

## Usuarios
- `GET /api/usuarios/:empresa_id` · `GET /api/usuarios/:empresa_id/:id`
- Cada usuario trae `email`, `activo`, `role_id` y `rol`.
- `POST /api/usuarios/:empresa_id` *(Admin)* — `{ "nombre", "codigo_ingreso", "puesto?", "role_id?", "is_admin?", "email?", "password?" }`
- `PUT /api/usuarios/:empresa_id/:id` *(Admin)* — `nombre` y `codigo_ingreso` requeridos; el resto es opcional y **lo que no se envía se conserva**: `puesto`, `is_admin`, `role_id`, `email`, `password` (se hashea), `activo` y `forzar_cierre_sesion` (revoca las sesiones vigentes del usuario). `is_owner` no se cambia por API. Nadie puede desactivarse ni quitarse Admin a sí mismo, y al dueño no se le desactiva ni se le quita Admin (`400`).
- `DELETE /api/usuarios/:empresa_id/:id` *(Admin)* — borrado físico; para conservar historial usa `activo: false`.

## Proveedores
Cada proveedor trae `activo`. El borrado es **lógico** (soft-delete): nunca se elimina físicamente, para conservar el historial de compras y productos.
- `GET /api/proveedores/:empresa_id` — solo **activos** por defecto; `?incluir_inactivos=true` incluye los desactivados. `GET /api/proveedores/:empresa_id/:id`.
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

## Inventario (solo lectura)
- `GET /api/inventario/:empresa_id` · `GET /api/inventario/:empresa_id/:id`

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
Mezcla de ventas por receta y **costo % ponderado** (ingeniería de menú), agregando `venta_diaria` + `venta_diaria_detalle`. Por defecto, los últimos 30 días hasta ayer. Valida `desde <= hasta` y rango ≤ 366 días (mismos mensajes que `finanzas/resumen`; `400` con `details`). Solo cuenta líneas `tipo='RECETA'`; los días revertidos ya no existen (CASCADE). El `costo_teorico` usa el **costo vigente** de la receta (no el histórico). Por receta: `unidades`, `ingreso` (precio capturado, normalmente con IVA), `ingreso_neto` (sin IVA cuando `precio_incluye_iva`), `costo_teorico` = `unidades × costo_total`, `costo_pct` = `costo_teorico / ingreso_neto × 100` (null si neto 0) y `utilidad`. Ordenadas por `unidades` desc (incluye inactivas si se vendieron). `totales.costo_pct` es el ponderado (Σcosto_teorico / Σingreso_neto). `sin_receta: { lineas, unidades }` = líneas `SIN_MAPEO`/`INSUMO` que quedan fuera. Sin días importados → `recetas: []`, totales en 0, `costo_pct: null`, `dias_importados: 0`.
```json
{ "periodo": { "desde": "2026-08-27", "hasta": "2026-09-25" }, "dias_importados": 24,
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

### Cascada de costos
Cuando cambia el costo o la **merma** de un insumo (compra, `PUT` de producto) o el costo de una preparación (su receta cambió), se refresca `receta_detalle.costo_unitario` (= **costo útil**) de las recetas que lo usan y se recalcula su `costo_total`; si esas recetas son preparaciones, la cascada continúa (con protección contra ciclos).

## Detalle de receta (ingredientes)
- `GET /api/recetas/:receta_id/detalle` · `GET .../detalle/:id`
- `POST /api/recetas/:receta_id/detalle` — `{ "producto_id": 7, "cantidad": 200 }`
- `PUT .../detalle/:id` · `DELETE .../detalle/:id`
- Cada renglón trae `producto_id`, `producto`, `unidad_medida`, `es_elaborado`, `cantidad`, `costo_unitario` (costo del insumo al guardar el renglón) y `costo_final`.

---

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

## Conteo físico (varianza y reconciliación)

### `GET /api/conteos/:empresa_id/plantilla`
Productos con su stock teórico actual, para llenar el conteo.

### `POST /api/conteos/:empresa_id`
Calcula varianza vs. teórico y reconcilia el inventario con `AJUSTE` (transacción):
```json
{ "fecha?": "2026-09-21", "motivo?": "Corte semanal",
  "lineas": [ { "producto_id": 1, "stock_fisico": 4850 } ] }
```
Respuesta: `data.detalle` (varianza y valor por producto) + `data.resumen` (`valor_merma`, `valor_sobrante`, `valor_neto`).
- `GET /api/conteos/:empresa_id` · `GET /api/conteos/:empresa_id/:id`
- `POST /api/conteos/:empresa_id/:id/anular` *(Admin)* — `{ "motivo": "..." }`. Revierte cada línea con un `AJUSTE` de signo contrario a la varianza aplicada (`referencia_tipo=CONTEO_ANULADO`) y marca `anulado=true`. Mismo patrón de bloqueo de fila e idempotencia que compras/producción: reintentar sobre un conteo ya anulado → `409`.

## Ventas (importación diaria del POS)

### PosMap — mapea nombres del reporte a recetas/insumos
- `GET /api/pos-map/:empresa_id`
- `POST /api/pos-map/:empresa_id` — `{ "nombre_pos": "Chilaquiles Verdes", "tipo": "RECETA|INSUMO|IGNORAR", "receta_id?": 2, "producto_id?": null, "factor?": 1 }`
- `POST /api/pos-map/:empresa_id/bulk` — arreglo de mapeos (devuelve los creados) · `PUT` · `DELETE`. `receta_id`/`producto_id` deben ser de la misma empresa, o `400`.

### Importar ventas
- `POST /api/ventas/:empresa_id/importar`
```json
{ "fecha": "2026-09-20", "lineas": [ { "nombre_pos": "Chilaquiles Verdes", "cantidad": 4 } ] }
```
También acepta `"csv": "<reporte Toteat crudo>"`. Explota recetas a insumos y descuenta stock. Reimportar el mismo día → `409` (revierte primero).

**Descuento en bruto (merma):** las recetas se capturan en **neto** (lo que va al plato); al descontar inventario, cada insumo con `merma_pct` se descuenta en **bruto** = `neto / (1 − merma/100)`, redondeado a 3 decimales (ej. 100 g netos con 8% → 108.696 g). Aplica a importar/preview de ventas, auto-producción y `produccion`. Los mapeos POS tipo **INSUMO** se descuentan tal cual (sin merma); compras y conteo siguen en bruto. El movimiento usa el costo **bruto**, así el valor cuadra (bruto × costo bruto = neto × costo útil).

**Auto-producción de preparaciones:** si un platillo lleva una preparación (p. ej. salsa) y el stock de esa preparación no alcanza, el faltante se **auto-produce** desde sus insumos dentro de la misma transacción (recursivo, tope de 5 niveles; un ciclo entre preparaciones → `400`). Movimientos: `PRODUCCION` de salida por los insumos (permite negativo), `PRODUCCION` de entrada por el elaborado (costo = costo vigente del elaborado) y la `VENTA` normal del consumo — así la preparación queda en 0 y no negativa. Si un insumo no alcanza, queda negativo y el import **no** se detiene.

La respuesta de `importar` (y de `preview`) agrega `auto_produccion: [{ producto_id, producto, receta_id, cantidad, unidad, lotes_equivalentes, insumos: [{ producto_id, producto, cantidad, stock_resultante }] }]`. En `preview`, el `consumo` lista cada producto con `{ producto_id, producto, cantidad, existencia_resultante, negativo }` (incluye los insumos crudos de la auto-producción).
- `GET /api/ventas/:empresa_id/:fecha` (consultar) — devuelve `movimientos` y `auto_produccion` (reconstruida desde los movimientos) · `DELETE /api/ventas/:empresa_id/:fecha` (revertir) — deshace **todos** los movimientos del día (VENTA→DEVOLUCION; la auto-producción se revierte con el inverso de `PRODUCCION`, que **no** afecta `costo_ventas` ni la merma), dejando cada existencia exactamente como estaba.
- `GET /api/ventas/:empresa_id?desde=&hasta=` — días importados: `{ fecha, total_lineas, total_unidades, procesado_at, insumos_negativos }`. `insumos_negativos` cuenta los productos que quedaron en negativo al importar, tanto por `VENTA` como por la `PRODUCCION` de la auto-producción.
- `POST /api/ventas/:empresa_id/preview` — `{ csv | lineas }` devuelve el mapeo, el consumo resultante y la auto-producción **sin guardar nada**.

## Reportes (solo lectura)
- `GET /api/reportes/:empresa_id/estado?fecha=YYYY-MM-DD` — KPIs del día: valor de inventario, alertas, compras/consumo/mermas del día.
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
- `POST /api/finanzas/:e/ingresos/lote` *(Admin y Operativo)* — cierre del día en una transacción:
```json
{ "fecha": "2026-09-21", "lineas": [ { "metodo_pago": "EFECTIVO", "monto": 3200 }, { "metodo_pago": "TARJETA", "monto": 1850 } ] }
```
- `PUT /api/finanzas/:e/ingresos/:id` *(Admin)*; `POST /api/finanzas/:e/ingresos/:id/anular` *(Admin)* `{ "motivo" }`.

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
  "serie": [ { "periodo": "2026-09-01", "ingresos": 1500, "ingresos_neto": 1293.10, "compras": 600, "gastos_extra": 0, "costo_ventas": 500 } ]
}
```
`costo_ventas` = Σ movimientos `VENTA`×costo − Σ `DEVOLUCION` de reversas (`referencia_tipo='VENTA_DIARIA'`). `resultado_operacion` = ingresos − costo_ventas − gastos.extra (las compras entran como inventario, no aquí). `food_cost_pct` = null si no hay ingresos. `ingreso_esperado` = Σ `venta_diaria_detalle.cantidad × precio_unitario` (snapshot de `recetas.precio_venta` al importar); null si ningún día del rango tiene detalle. `ingresos_comparables` = ingresos no anulados **solo** en las fechas del rango que tienen detalle (para comparar contra `ingreso_esperado`); null cuando `ingreso_esperado` es null. Los días importados antes de la migración 014 no tienen detalle.

---

## Punto de venta (mesas, cuentas y comandas)

POS propio: mesas, cuentas, comandas por área, precuenta, apertura de caja **cobro** (pagos mixtos, propina, descuento de inventario y cierre de mesa) **corte de caja** y **autorizaciones** (descuentos, cortesías, cancelaciones y anulación de una cuenta cobrada). Todas las rutas cuelgan de `/api/pos/:empresa_id`.

**Permisos** (en `roles.permisos`; Admin/Owner siempre pasan): `pos.ver` (mapa y consulta), `pos.ordenar` (abrir cuentas, productos, enviar comandas, cambiar/juntar/dividir), `pos.cobrar` (caja), `pos.autorizar` (cancelar lo ya enviado, ver la cola). `mesero` → ver+ordenar · `cajero` → ver+ordenar+cobrar · `supervisor` → todos · `hostess`/`recepcion` → solo ver. `GET /api/auth/me` y el login devuelven `permisos`.

### Configuración *(Admin; las lecturas piden `pos.ver`)*
- `GET|POST /areas` · `PUT /areas/:id` — áreas de preparación (`Cocina` predeterminada, `Barra`, `Sin comanda`; `imprime=false` = no genera comanda). Se siembran en el primer `GET`. El área predeterminada no se puede desactivar.
- `GET|POST /mesas` · `PUT /mesas/:id` — `{ nombre, zona?, capacidad?, orden?, activo? }`.
- `GET /asignacion-areas` · `PUT /asignacion-areas/categoria/:id` · `PUT /asignacion-areas/:receta|producto/:id` — `{ "area_id": 2 | null }`. El área de un artículo se resuelve **artículo → categoría → predeterminada**.
- `GET /menu` — artículos vendibles (recetas activas no-preparación con precio > 0 y productos con `precio_venta`), con `area_id`, `area_origen`, precio e IVA, más `recetas_sin_precio`.

### Cuentas
- `GET /mapa` *(ver)* — `{ mesas: [{ ..., cuentas: [{ id, folio, total, por_enviar, mesero, abierta_at }] }], llevar: [...] }`.
- `POST /cuentas` *(ordenar)* — `{ tipo: "MESA"|"LLEVAR", mesa_id?, personas?, nombre_cliente? }`. Una mesa no se abre dos veces (**409**, también en solicitudes simultáneas). El folio es consecutivo por empresa.
- `GET /cuentas/:id` — cuenta con `items` y `totales { subtotal, descuento, iva, total }` (IVA incluido o sumado según el precio de cada renglón).
- `POST /cuentas/:id/items` — `{ lineas: [{ tipo: "RECETA"|"PRODUCTO", id, cantidad, notas? }] }`. Nombre, precio e IVA quedan **congelados** en el renglón. El mismo artículo sin notas y sin enviar se suma al renglón existente (tope 99).
- `PUT|DELETE /cuentas/:id/items/:itemId` — solo renglones `PENDIENTE` (**409** si ya se enviaron).
- `POST /cuentas/:id/items/:itemId/cancelar` *(autorizar)* — `{ motivo }`; deja el renglón `CANCELADO` con quién lo autorizó.
- `POST /cuentas/:id/enviar` — crea **una comanda por área** con lo pendiente, marca los renglones `ENVIADO` y encola la impresión. `{ comandas: [{ numero, area, renglones, impresion_estado }], sin_comanda, cuenta }`. Si el área no tiene impresora, esa impresión queda en `ERROR` (no se pierde).
- `POST /cuentas/:id/cambiar-mesa` `{ mesa_id }` (mesa libre) · `POST /cuentas/:id/juntar` `{ destino_id }` (la origen queda `UNIDA`) · `POST /cuentas/:id/dividir` `{ partes: [{ item_id, cantidad }] }` (crea una cuenta nueva en la misma mesa; no puede vaciar la original) · `POST /cuentas/:id/precuenta` (encola el estado de cuenta a la impresora de tickets) · `POST /cuentas/:id/cancelar` `{ motivo? }` (con productos enviados exige `pos.autorizar` y motivo).
- `POST /cuentas/:id/cobrar` *(cobrar)* `{ pagos: [{ metodo: EFECTIVO|TARJETA|TRANSFERENCIA, monto, propina?, recibido?, referencia? }] }` — cobra en **una transacción**: guarda los pagos, descuenta el inventario (movimientos `VENTA` con `referencia_tipo = 'POS_CUENTA'`, `referencia_id` = id de la cuenta), cierra la cuenta (`PAGADA`, la mesa queda libre) y encola el ticket. Reglas: el cajero necesita turno abierto (**409** «Abre tu caja»); la cuenta no puede tener productos sin enviar (**400**); la suma de `monto` debe igualar el total exacto, la propina va aparte y no cuenta para el total; en efectivo `recibido` (opcional, por defecto exacto) debe cubrir `monto + propina` y el cambio es la diferencia; un pago puede ser solo propina (`monto: 0`); una cuenta de total 0 se cierra sin pagos. Una cuenta ya cobrada responde **409** (dos cajas a la vez: gana una). La venta queda en el turno y el día de negocio de quien cobra. Respuesta: `{ cambio, propina, ticket: { impresion_id, impresion_estado }, inventario: { negativos, errores, recetas_sin_escandallo }, cuenta }`. El inventario nunca bloquea el cobro: si una existencia queda negativa se reporta en `negativos`.
- **Autorización de supervisor.** Descuentos, cortesías, cancelar un renglón enviado, cancelar una cuenta con productos enviados y anular una cuenta cobrada requieren `pos.autorizar`. Quien no lo tiene puede mandar en el cuerpo `autorizacion: { email, password }` de un supervisor/Admin/Owner **de la misma empresa** (las mismas credenciales del login, se validan con bcrypt y no se guardan): esa persona queda como quien autorizó. Credenciales inválidas o de alguien sin permiso → **403**; sin credenciales ni permiso → **403**. Los intentos con credenciales se limitan a 15 por minuto por usuario. Todo queda en `pos_autorizaciones` (quién autorizó, quién lo pidió, importe y motivo).
- `POST /cuentas/:id/items/:itemId/descuento` · `POST /cuentas/:id/descuento` *(ordenar + autorización)* `{ tipo: PORCENTAJE|MONTO|CORTESIA|QUITAR, valor?, motivo, autorizacion? }` — solo en cuentas abiertas y renglones no cancelados. `PORCENTAJE` (0–100] y `MONTO` (máx. 2 decimales, sin pasar del importe) dan un descuento; `CORTESIA` cubre todo el renglón y **el inventario sí se descuenta al cobrar**; `QUITAR` regresa el precio de lista (sin motivo). A toda la cuenta, un monto se reparte en proporción al importe de cada renglón (y sustituye los descuentos previos). Una cuenta con total 0 se cobra con `pagos: []`.
- `POST /cuentas/:id/anular` *(cobrar + autorización)* `{ motivo, autorizacion? }` — solo cuentas `PAGADA` (**409** si ya está anulada o sigue abierta). En una transacción: regresa el inventario (`DEVOLUCION` al mismo costo, también la producción automática), marca los pagos como `anulado`, registra el dinero devuelto en `pos_devoluciones` en el turno de quien lo entrega (si hubo efectivo necesita caja abierta: **409** «Abre tu caja») y, si el turno de la venta ya cerró, descuenta lo devuelto de los ingresos que generó el corte (si llegan a 0 el ingreso se anula). El corte ya cerrado conserva sus cifras; la anulación se ve en `anuladas`. Para Finanzas, el costo de ventas ya considera las `DEVOLUCION` de `POS_CUENTA`.
- `POST /cuentas/:id/ticket` *(ordenar)* — vuelve a imprimir el ticket de una cuenta cobrada; sale marcado como copia y sin abrir el cajón (**404** si la cuenta no tiene ticket).
- `GET /turnos/actual` *(ver)* · `POST /turnos/abrir` *(cobrar)* `{ fondo_inicial }` — un cajero no puede tener dos turnos abiertos (**409**).
- **Corte de caja** *(cobrar; el cajero ve y cierra sus turnos, quien tiene `pos.autorizar` cualquiera, otro cajero **403**)*:
  - `GET /turnos` — turnos recientes con ventas, esperado, contado y diferencia.
  - `GET /turnos/:id/corte` — `{ turno, corte, ventas, anuladas, autorizaciones, cuentas_abiertas, es_ultimo_turno }` (`autorizaciones` = lo autorizado mientras duró el turno). Abierto = corte parcial. `corte` trae `por_metodo` (`cuentas`, `monto`, `propina`), `ventas` (sin propinas), `propinas`, `efectivo_cobrado` (ventas + propina en efectivo; el cambio ya salió; incluye ventas que luego se anularon), `devoluciones_efectivo` (efectivo devuelto por anulaciones desde este cajón) y `efectivo_esperado` = fondo + efectivo cobrado − devoluciones − propinas entregadas. Un turno cerrado devuelve su corte tal como se cerró.
  - `POST /turnos/:id/cerrar` `{ efectivo_contado, propinas_entregadas?, nota?, forzar? }` — en una transacción: guarda esperado, contado y `diferencia` (contado − esperado: positivo sobra), cierra el turno, **genera los ingresos de Finanzas por método** (solo ventas, nunca propinas; `concepto` «Corte de caja · turno N», `pos_turno_id`, un ingreso por método y turno) y encola el corte para imprimir. Las propinas entregadas no pueden pasar de las cobradas (**400**). Si hay cuentas abiertas con productos y no queda otra caja abierta responde **409** salvo `forzar: true` (se cobrarán después, en otro turno). Un turno cerrado responde **409**; los cobros que llegan durante el cierre esperan y, si el turno ya cerró, reciben «Abre tu caja».
  - `POST /turnos/:id/corte/imprimir` — vuelve a imprimir el corte (parcial o definitivo).

### Impresión
Las comandas, precuentas y tickets se encolan en `pos_impresiones` (el ticket lleva `abrir_cajon: true` si hubo efectivo); el **agente de impresión** (carpeta `print-agent/`) las toma y las imprime en cada impresora (red o USB).
- `GET|POST /impresoras` · `PUT /impresoras/:id` · `POST /impresoras/:id/prueba` *(Admin)* — `{ nombre, conexion: "RED"|"USB", ip?, puerto?, nombre_usb?, ancho: 58|80, area_id?, es_ticket? }`; una impresora atiende un área o es la de tickets.
- `GET|POST /agentes` · `PUT /agentes/:id` · `POST /agentes/:id/rotar-token` *(Admin)* — el token (`gh_agt_...`) se devuelve **una sola vez**; en la base solo queda su hash.
- `GET /impresion/estado` *(ver)* — `{ agentes_conectados, pendientes, errores }` (conectado = contacto en los últimos 30 s).
- `GET /impresiones?estado=` *(autorizar)* · `POST /impresiones/:id/reimprimir` *(ordenar)*.
- **Agente** (`/api/agente/*`, autenticado con `Authorization: Bearer <token del agente>`, fuera de la sesión de usuario): `GET /impresiones/pendientes` toma los trabajos de forma atómica (uno no confirmado en 30 s se reintenta); `POST /impresiones/:id/resultado` `{ ok, error? }` — un fallo se reintenta con espera y a los 5 intentos queda en `ERROR`. Cada trabajo trae `reimpresiones` para distinguir una reimpresión manual de una re-entrega.

---

## Flujo end-to-end recomendado

1. `POST /api/auth/login` → token (o `/setup` la primera vez para el primer usuario de toda la base; luego, nuevas empresas se crean con `POST /api/platform/empresas`, que exige `is_platform_admin`).
2. `POST /api/proveedores/:e` y `POST /api/productos/:e` (insumos).
3. `POST /api/recetas/:e` con `es_preparacion` (salsa) → `POST /api/produccion/:e/confirmar` (producirla).
4. `POST /api/recetas/:e` del platillo usando la preparación como ingrediente.
5. `POST /api/pos-map/:e` y `POST /api/ventas/:e/importar` (vender).
6. `POST /api/conteos/:e` (contar) y `GET /api/reportes/:e/estado` (ver los números).
