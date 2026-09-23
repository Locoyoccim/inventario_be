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
`GET /health` (público, sin token) → `{ "status": "ok", "uptime": ..., "ts": "..." }`. Útil para monitoreo y deploy.

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
Público. Borra la cookie de sesión → `{ "success": true, "data": null }`. (Un JWT ya emitido sigue siendo válido hasta expirar si alguien lo copió; no hay lista de revocación.)

### `GET /api/auth/me`
Con Bearer o cookie → devuelve el perfil actual desde BD: `{ id, nombre, email, empresa_id, is_admin, is_owner }` (mismo formato que `user` en login). `401` si el usuario ya no existe.

### Roles: Admin vs Operativo
Cada usuario es **Admin** (`is_owner` o `is_admin` = true) u **Operativo** (lo demás).
- **Admin**: acceso total.
- **Operativo**: puede registrar **ventas**, **conteos** y **compras**, y **leer** todo (productos, inventario, recetas, reportes, categorías). NO puede crear/editar productos, recetas, costos, proveedores, usuarios, pos-map ni categorías, ni confirmar producción, ni revertir ventas → responde `403`.

Un Admin crea usuarios Operativo con `POST /api/usuarios/:empresa_id` incluyendo `email` + `password` y `is_admin`/`is_owner` en `false`.

---

## Empresas
- `GET /api/empresas` — lista (solo la propia)
- `GET /api/empresas/:id`
- `POST /api/empresas` *(owner/admin)* — `{ "nombre", "titular?", "telefono?", "email?", "domicilio?" }`
- `PUT /api/empresas/:id` *(owner/admin)*
- `DELETE /api/empresas/:id` *(owner/admin)*

## Usuarios
- `GET /api/usuarios/:empresa_id` · `GET /api/usuarios/:empresa_id/:id`
- `POST /api/usuarios/:empresa_id` — `{ "nombre", "codigo_ingreso", "puesto?", "role_id?", "is_admin?", "is_owner?" }`
- `PUT /api/usuarios/:empresa_id/:id` · `DELETE /api/usuarios/:empresa_id/:id`

## Proveedores
- `GET /api/proveedores/:empresa_id` · `GET /api/proveedores/:empresa_id/:id`
- `POST /api/proveedores/:empresa_id` — `{ "nombre", "telefono?", "email?", "domicilio?" }`
- `PUT` · `DELETE` (mismos campos)

## Categorías (lista compartida, administrable)
Una sola lista por empresa para productos y recetas; el front la usa para el selector. Se siembra con las categorías que ya usabas.
- `GET /api/categorias/:empresa_id` — lista (cualquier usuario autenticado)
- `POST /api/categorias/:empresa_id` *(Admin)* — `{ "nombre": "Bebidas" }` (nombre único por empresa → `409` si se repite)
- `PUT /api/categorias/:empresa_id/:id` *(Admin)* — `{ "nombre": "Bebidas Frías" }`
- `DELETE /api/categorias/:empresa_id/:id` *(Admin)*

---

## Productos

Campos: `producto, unidad_medida, proveedor_id, categoria, cantidad_presentacion, costo_presentacion`. El `costo_unitario` es **calculado** (`costo_presentacion / cantidad_presentacion`). El stock vive en inventario y **solo** cambia por `/movimientos`, `/compras`, `/produccion` o `/conteos`.

### `GET /api/productos/:empresa_id`
Filtros: `?q=<nombre>` (búsqueda parcial), `?categoria=<exacta>`, `?bajo_minimo=true` (stock < mínimo), `?incluir_inactivos=true` (incluye desactivados). Cada fila trae `stock_actual`, `stock_minimo`, `es_elaborado` y `activo`.

### `POST /api/productos/:empresa_id`
```json
{ "producto": "Tomate Verde", "unidad_medida": "g", "proveedor_id": 1, "categoria": "Insumo",
  "cantidad_presentacion": 1000, "costo_presentacion": 25, "stock_actual": 5000, "stock_minimo": 1000 }
```

### `PUT /api/productos/:empresa_id/:id`
Mismos campos (sin `stock_actual`) + opcional `"activo": true|false`. Un producto **elaborado** (preparación) no se edita aquí → `400`.

### `DELETE /api/productos/:empresa_id/:id`
**Soft-delete**: marca `activo=false` (conserva el historial). No borra físicamente. Reactivar con `PUT ... {"activo": true}`.

## Inventario (solo lectura)
- `GET /api/inventario/:empresa_id` · `GET /api/inventario/:empresa_id/:id`

## Movimientos de inventario
- `GET /api/productos/:empresa_id/:id/movimientos` — historial paginado del producto
- `POST /api/productos/:empresa_id/:id/movimientos` — ajuste manual de stock
```json
{ "tipo_movimiento": "COMPRA|VENTA|MERMA|AJUSTE|DEVOLUCION|PRODUCCION", "cantidad": 10,
  "motivo?": "texto", "costo_unitario?": 0.03 }
```
`AJUSTE` usa el signo de `cantidad`; los demás tienen dirección fija. Para compras reales usa `/compras` (actualiza costo).

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

## Detalle de receta (ingredientes)
- `GET /api/recetas/:receta_id/detalle` · `GET .../detalle/:id`
- `POST /api/recetas/:receta_id/detalle` — `{ "producto_id": 7, "cantidad": 200 }`
- `PUT .../detalle/:id` · `DELETE .../detalle/:id`

---

## Producción (preparaciones)

### `GET /api/produccion/:empresa_id/sugerencias`
Preparaciones bajo mínimo con lotes sugeridos e insumos requeridos.

### `POST /api/produccion/:empresa_id/confirmar`
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
- `GET /api/compras/:empresa_id` (historial) · `GET /api/compras/:empresa_id/:id` (encabezado + líneas)

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
- `POST /api/pos-map/:empresa_id/bulk` — arreglo de mapeos · `PUT` · `DELETE`

### Importar ventas
- `POST /api/ventas/:empresa_id/importar`
```json
{ "fecha": "2026-09-20", "lineas": [ { "nombre_pos": "Chilaquiles Verdes", "cantidad": 4 } ] }
```
También acepta `"csv": "<reporte Toteat crudo>"`. Explota recetas a insumos y descuenta stock. Reimportar el mismo día → `409` (revierte primero).
- `GET /api/ventas/:empresa_id/:fecha` (consultar) · `DELETE /api/ventas/:empresa_id/:fecha` (revertir)

## Reportes (solo lectura)
- `GET /api/reportes/:empresa_id/estado?fecha=YYYY-MM-DD` — KPIs del día: valor de inventario, alertas, compras/consumo/mermas del día.
- `GET /api/reportes/:empresa_id/inventario` — valorización por producto + totales.
- `GET /api/reportes/:empresa_id/alertas` — bajo mínimo con acción (`comprar`/`producir`).
- `GET /api/reportes/:empresa_id/actividad?desde=&hasta=` — movimientos por tipo + merma (default últimos 30 días).
- `GET /api/reportes/:empresa_id/consumo?desde=&hasta=&limit=` — top productos consumidos por ventas.

---

## Flujo end-to-end recomendado

1. `POST /api/auth/login` → token (o `/setup` la primera vez; roles y empresa se siembran por SQL).
2. `POST /api/proveedores/:e` y `POST /api/productos/:e` (insumos).
3. `POST /api/recetas/:e` con `es_preparacion` (salsa) → `POST /api/produccion/:e/confirmar` (producirla).
4. `POST /api/recetas/:e` del platillo usando la preparación como ingrediente.
5. `POST /api/pos-map/:e` y `POST /api/ventas/:e/importar` (vender).
6. `POST /api/conteos/:e` (contar) y `GET /api/reportes/:e/estado` (ver los números).
