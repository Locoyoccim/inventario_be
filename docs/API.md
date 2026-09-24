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

### Roles: Admin vs Operativo
Cada usuario es **Admin** (`is_owner` o `is_admin` = true) u **Operativo** (lo demás).
- **Admin**: acceso total.
- **Operativo**: puede registrar **ventas**, **conteos** y **compras**, y **leer** todo (productos, inventario, recetas, reportes, categorías). También **confirma producción**. NO puede crear/editar productos, recetas, costos, proveedores, usuarios, pos-map ni categorías, ni revertir ventas → responde `403`.
- Un usuario **desactivado** (`activo: false`) no puede iniciar sesión (`403`) y sus tokens vigentes dejan de servir (`401`, a más tardar en 1 minuto).

Un Admin crea usuarios Operativo con `POST /api/usuarios/:empresa_id` incluyendo `email` + `password` y `is_admin`/`is_owner` en `false`.

---

## Empresas
- `GET /api/empresas` — lista (solo la propia)
- `GET /api/empresas/:id`
- `POST /api/empresas` *(plataforma)* — crea un tenant nuevo; exige el header `x-platform-token: <PLATFORM_TOKEN>` (sin esa variable, el endpoint queda cerrado). `{ "nombre", "titular?", "telefono?", "email?", "domicilio?" }`
- `PUT /api/empresas/:id` *(owner/admin)*
- `DELETE /api/empresas/:id` *(solo dueño)* — borra la empresa (en cascada); requiere `is_owner`.

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
- `GET /api/proveedores/:empresa_id/:id/resumen` *(Admin)* — historial del proveedor: `{ ultimas_compras: [...10], total_30d, total_90d, ultimo_precio_por_producto: [{ producto_id, producto, costo_unitario, fecha }] }`.
- Un producto o compra **no** puede usar un proveedor inactivo (o de otra empresa) → `400`. Un producto que ya referencia un proveedor desactivado sigue mostrando su nombre y puede editarse mientras no cambie de proveedor.

## Categorías (lista compartida, administrable)
Una sola lista por empresa para productos y recetas; el front la usa para el selector. Se siembra con las categorías que ya usabas.
- `GET /api/categorias/:empresa_id` — lista (cualquier usuario autenticado)
- `POST /api/categorias/:empresa_id` *(Admin)* — `{ "nombre": "Bebidas" }` (nombre único por empresa → `409` si se repite)
- `PUT /api/categorias/:empresa_id/:id` *(Admin)* — `{ "nombre": "Bebidas Frías" }`
- `DELETE /api/categorias/:empresa_id/:id` *(Admin)*

---

## Productos

Campos: `producto, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion`. El `costo_unitario` es **calculado** (`costo_presentacion / cantidad_presentacion`) con 4 decimales; `costo_presentacion` admite hasta 4 decimales (migración 011), de modo que insumos con presentación chica (p.ej. `cantidad_presentacion=1`) conservan el costo real (ej. `0.0123`) sin redondear a `0.01`. El stock vive en inventario y **solo** cambia por `/movimientos`, `/compras`, `/produccion` o `/conteos`.

### `GET /api/productos/:empresa_id`
Filtros: `?q=<nombre>` (búsqueda parcial), `?categoria=<exacta>`, `?bajo_minimo=true` (stock < mínimo), `?incluir_inactivos=true` (incluye desactivados). Cada fila trae `proveedor_id`, `proveedor` (nombre), `stock_actual`, `stock_minimo`, `es_elaborado` y `activo`.

### `POST /api/productos/:empresa_id`
```json
{ "producto": "Tomate Verde", "unidad_medida": "g", "proveedor_id": 1, "categoria": "Insumo",
  "cantidad_presentacion": 1000, "costo_presentacion": 25, "stock_actual": 5000, "stock_minimo": 1000 }
```

### `PUT /api/productos/:empresa_id/:id`
Mismos campos (sin `stock_actual`) + opcional `"activo": true|false`. Un producto **elaborado** (preparación) no se edita aquí → `400`.
Si cambia el costo, las recetas que usan el producto se recalculan en la misma transacción (ver *Cascada de costos*); la respuesta trae `recetas_actualizadas`.

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

Campos: `nombre, categoria, precio_venta, costo_produccion?, proteccion_pct?, ingredientes[]`. `costo_total` y `margen` se calculan en el backend con la fórmula única `(insumos + producción) × (1 + protección%)`.

### `GET /api/recetas/:empresa_id`
Filtros: `?q=`, `?categoria=`, `?incluir_inactivos=true`.

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
Body: `nombre`, `categoria`, `precio_venta`, opcionales `activo`, `costo_produccion`, `proteccion_pct` y **`ingredientes`**.
- Sin `ingredientes`: solo se actualiza el encabezado (el escandallo no se toca).
- Con `ingredientes: [{ producto_id, cantidad }]` (mínimo 1): **guardado atómico** — encabezado + escandallo completo se reemplazan en UNA transacción con los costos vigentes; si algo falla (p. ej. un producto inexistente) no cambia nada → `400`. La respuesta incluye `ingredientes` con los renglones nuevos (los `id` de renglón cambian).
- Una preparación no puede llevarse a sí misma como ingrediente → `400`. `es_preparacion`, `rendimiento` y `unidad` no se editan aquí.

### Cascada de costos
Cuando cambia el costo de un insumo (compra, `PUT` de producto) o el de una preparación (su receta cambió), se refresca `receta_detalle.costo_unitario` de las recetas que lo usan y se recalcula su `costo_total`; si esas recetas son preparaciones, la cascada continúa (con protección contra ciclos).

## Detalle de receta (ingredientes)
- `GET /api/recetas/:receta_id/detalle` · `GET .../detalle/:id`
- `POST /api/recetas/:receta_id/detalle` — `{ "producto_id": 7, "cantidad": 200 }`
- `PUT .../detalle/:id` · `DELETE .../detalle/:id`
- Cada renglón trae `producto_id`, `producto`, `unidad_medida`, `es_elaborado`, `cantidad`, `costo_unitario` (costo del insumo al guardar el renglón) y `costo_final`.

---

## Producción (preparaciones)

### `GET /api/produccion/:empresa_id/sugerencias`
Preparaciones bajo mínimo con lotes sugeridos e insumos requeridos.

### `POST /api/produccion/:empresa_id/confirmar` *(Operativo o Admin)*
Consume insumos y suma stock de la preparación (movimientos `PRODUCCION`, transacción atómica):
```json
{ "producciones": [ { "receta_id": 1, "lotes": 1 } ] }
```

## Compras (entrada de mercancía + costo)

Suma stock (`COMPRA`) y actualiza el costo del producto al **precio de la última compra** (último costo). Un producto elaborado no se compra → `400`.

### `POST /api/compras/:empresa_id`
```json
{ "fecha?": "2026-09-21", "proveedor_id?": 1, "referencia?": "F-001",
  "lineas": [ { "producto_id": 1, "cantidad": 2000, "costo_total": 60 } ] }
```
Cada línea acepta `costo_total` (lo pagado) **o** `costo_unitario`.
Respuesta: `{ compra, lineas, recetas_actualizadas }` — las recetas que usan esos insumos se recalculan en la misma transacción (*Cascada de costos*).
- `GET /api/compras/:empresa_id` (historial) · `GET /api/compras/:empresa_id/:id` (encabezado + líneas)
- `POST /api/compras/:empresa_id/:id/anular` *(Admin)* — `{ "motivo?": "..." }`. Revierte la compra: descuenta con un movimiento `AJUSTE` negativo (`referencia_tipo=COMPRA_ANULADA`) el stock que había sumado y marca `anulado=true` (`anulado_at`, `anulado_por`, `motivo_anulacion`). Reglas: si al revertir alguna línea el stock quedaría **negativo** → `409` y **no** se anula nada. El costo del producto se **restaura** solo si esta compra fue la **última** que fijó su costo (si hubo compras posteriores, el costo vigente no se toca). Las compras anuladas se excluyen del libro de finanzas. Idempotente: reintentar sobre una compra ya anulada → `409`.

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
- `GET /api/ventas/:empresa_id/:fecha` (consultar) · `DELETE /api/ventas/:empresa_id/:fecha` (revertir)
- `GET /api/ventas/:empresa_id?desde=&hasta=` — días importados: `{ fecha, total_lineas, total_unidades, procesado_at, insumos_negativos }` (insumos que quedaron en negativo al importar).
- `POST /api/ventas/:empresa_id/preview` — `{ csv | lineas }` devuelve el mapeo y el consumo resultante **sin guardar nada**.

## Reportes (solo lectura)
- `GET /api/reportes/:empresa_id/estado?fecha=YYYY-MM-DD` — KPIs del día: valor de inventario, alertas, compras/consumo/mermas del día.
- `GET /api/reportes/:empresa_id/inventario` — valorización por producto + totales.
- `GET /api/reportes/:empresa_id/alertas` — bajo mínimo con acción (`comprar`/`producir`).
- `GET /api/reportes/:empresa_id/actividad?desde=&hasta=` — movimientos por tipo + merma (default últimos 30 días).
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
- `GET /api/finanzas/:e/resumen?desde&hasta&agrupar=dia|semana|mes` — rango máximo 366 días, `desde <= hasta`, anulados excluidos.
```json
{
  "periodo": { "desde": "2026-09-01", "hasta": "2026-09-30" },
  "ingresos": { "total": 42000, "por_metodo": [ { "metodo_pago": "EFECTIVO", "total": 25000 } ] },
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
  "serie": [ { "periodo": "2026-09-01", "ingresos": 1500, "compras": 600, "gastos_extra": 0, "costo_ventas": 500 } ]
}
```
`costo_ventas` = Σ movimientos `VENTA`×costo − Σ `DEVOLUCION` de reversas (`referencia_tipo='VENTA_DIARIA'`). `resultado_operacion` = ingresos − costo_ventas − gastos.extra (las compras entran como inventario, no aquí). `food_cost_pct` = null si no hay ingresos. `ingreso_esperado` = Σ `venta_diaria_detalle.cantidad × precio_unitario` (snapshot de `recetas.precio_venta` al importar); null si ningún día del rango tiene detalle. `ingresos_comparables` = ingresos no anulados **solo** en las fechas del rango que tienen detalle (para comparar contra `ingreso_esperado`); null cuando `ingreso_esperado` es null. Los días importados antes de la migración 014 no tienen detalle.

---

## Flujo end-to-end recomendado

1. `POST /api/auth/login` → token (o `/setup` la primera vez; roles y empresa se siembran por SQL).
2. `POST /api/proveedores/:e` y `POST /api/productos/:e` (insumos).
3. `POST /api/recetas/:e` con `es_preparacion` (salsa) → `POST /api/produccion/:e/confirmar` (producirla).
4. `POST /api/recetas/:e` del platillo usando la preparación como ingrediente.
5. `POST /api/pos-map/:e` y `POST /api/ventas/:e/importar` (vender).
6. `POST /api/conteos/:e` (contar) y `GET /api/reportes/:e/estado` (ver los números).
