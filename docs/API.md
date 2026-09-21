# Referencia de API — Inventario Backend

> **v2:** todas las respuestas usan un sobre estándar y los POST/PUT validan con zod. Ver **Formato de respuesta estándar (v2)** y **Endpoints nuevos (v2)** al final.

API REST multiempresa para gestionar **empresas, usuarios, proveedores, productos, inventario, movimientos de stock y recetas**.

---

## Información general

| Concepto | Valor |
| --- | --- |
| URL base | `http://localhost:4000` |
| Prefijo de rutas | `/api` |
| Ejemplo | `http://localhost:4000/api/productos/4` |
| Formato | JSON |
| Header requerido (con body) | `Content-Type: application/json` |
| Autenticación | **Ninguna** — todos los endpoints son públicos (ver *Limitaciones* en el README) |

> Todos los recursos (salvo `empresas`, que es la raíz) cuelgan de una empresa y llevan `:empresa_id` en la URL. Los repositories filtran por ese `empresa_id` en cada query, así que un `id` que exista pero pertenezca a otra empresa responde `404`, no los datos de otra compañía.

### Códigos de respuesta

| Código | Significado |
| --- | --- |
| `200` | Solicitud exitosa |
| `201` | Recurso creado |
| `400` | Datos inválidos, campo requerido faltante, o violación de regla de negocio (ej. stock insuficiente) |
| `404` | Recurso no encontrado (o no pertenece a la empresa de la URL) |
| `500` | Error interno inesperado |

---

## Mapa de endpoints

| Módulo | Método | Ruta | Descripción |
| --- | --- | --- | --- |
| Empresas | `GET` | `/api/empresas` | Listar empresas |
| Empresas | `GET` | `/api/empresas/:id` | Obtener empresa |
| Empresas | `POST` | `/api/empresas` | Crear empresa |
| Empresas | `PUT` | `/api/empresas/:id` | Actualizar empresa |
| Empresas | `DELETE` | `/api/empresas/:id` | Eliminar empresa |
| Usuarios | `GET` | `/api/usuarios/:empresa_id` | Listar usuarios de una empresa |
| Usuarios | `GET` | `/api/usuarios/:empresa_id/:id` | Obtener usuario |
| Usuarios | `POST` | `/api/usuarios/:empresa_id` | Crear usuario |
| Usuarios | `PUT` | `/api/usuarios/:empresa_id/:id` | Actualizar usuario |
| Usuarios | `DELETE` | `/api/usuarios/:empresa_id/:id` | Eliminar usuario |
| Proveedores | `GET` | `/api/proveedores/:empresa_id` | Listar proveedores de una empresa |
| Proveedores | `GET` | `/api/proveedores/:empresa_id/:id` | Obtener proveedor |
| Proveedores | `POST` | `/api/proveedores/:empresa_id` | Crear proveedor |
| Proveedores | `PUT` | `/api/proveedores/:empresa_id/:id` | Actualizar proveedor |
| Proveedores | `DELETE` | `/api/proveedores/:empresa_id/:id` | Eliminar proveedor |
| Productos | `GET` | `/api/productos/:empresa_id` | Listar productos de una empresa |
| Productos | `GET` | `/api/productos/:empresa_id/:id` | Obtener producto |
| Productos | `POST` | `/api/productos/:empresa_id` | Crear producto (crea también su fila de inventario) |
| Productos | `PUT` | `/api/productos/:empresa_id/:id` | Actualizar producto (y su stock) |
| Productos | `DELETE` | `/api/productos/:empresa_id/:id` | Eliminar producto |
| Movimientos | `GET` | `/api/productos/:empresa_id/:id/movimientos` | Historial de movimientos de stock de un producto |
| Movimientos | `POST` | `/api/productos/:empresa_id/:id/movimientos` | Registrar un movimiento de stock (compra, venta, merma, ajuste, devolución, producción) |
| Inventario | `GET` | `/api/inventario/:empresa_id` | Listar stock de todos los productos de una empresa |
| Inventario | `GET` | `/api/inventario/:empresa_id/:id` | Obtener una fila de inventario por su `id` |
| Recetas | `GET` | `/api/recetas/:empresa_id` | Listar recetas de una empresa |
| Recetas | `GET` | `/api/recetas/:empresa_id/:id` | Obtener receta |
| Recetas | `POST` | `/api/recetas/:empresa_id` | Crear receta |
| Recetas | `PUT` | `/api/recetas/:empresa_id/:id` | Actualizar receta |
| Recetas | `DELETE` | `/api/recetas/:empresa_id/:id` | Eliminar receta |
| Detalle de receta | `GET` | `/api/recetas/:receta_id/detalle` | Listar ingredientes de una receta |
| Detalle de receta | `GET` | `/api/recetas/:receta_id/detalle/:id` | Obtener un ingrediente |
| Detalle de receta | `POST` | `/api/recetas/:receta_id/detalle` | Agregar un ingrediente a la receta |
| Detalle de receta | `PUT` | `/api/recetas/:receta_id/detalle/:id` | Cambiar producto/cantidad de un ingrediente |
| Detalle de receta | `DELETE` | `/api/recetas/:receta_id/detalle/:id` | Quitar un ingrediente |

> **Nota sobre `/inventario`:** el módulo es de **solo lectura**. El stock siempre se crea y se ajusta desde `/productos` (al crear/actualizar el producto) o desde `/productos/:empresa_id/:id/movimientos` (para registrar entradas/salidas con auditoría). No existen `POST`/`PUT`/`DELETE` directos sobre `/inventario` para evitar que dos rutas escriban el mismo dato de forma inconsistente.

---

## Empresas

Entidad raíz. Debe crearse antes que cualquier otro recurso. No lleva `empresa_id` porque es la propia empresa.

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `id` | integer | auto | Generado por la BD |
| `nombre` | string | Sí | |
| `titular` | string | Sí | |
| `telefono` | string | Sí | |
| `email` | string | Sí | |
| `domicilio` | string | Sí | |

### `POST /api/empresas`

```json
{
  "nombre": "Café Aroma",
  "titular": "Carlos Ramirez",
  "telefono": "5551234567",
  "email": "contacto@cafearoma.com",
  "domicilio": "Av. Principal 123"
}
```

Respuesta `201`:

```json
{
  "message": "Empresa creada exitosamente",
  "data": { "id": 4, "nombre": "Café Aroma", "titular": "Carlos Ramirez", "telefono": "5551234567", "email": "contacto@cafearoma.com", "domicilio": "Av. Principal 123" }
}
```

### `PUT /api/empresas/:id`

Mismo body que el `POST`, reemplaza todos los campos.

### `DELETE /api/empresas/:id`

```json
{ "message": "Empresa eliminada exitosamente", "id": "4" }
```

> Si la empresa tiene productos, proveedores o recetas asociados, el borrado falla con `400` por restricción de llave foránea (no hay cascada en esas relaciones).

---

## Usuarios

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `nombre` | string | Sí | |
| `codigo_ingreso` | string | Sí | Único en toda la BD (no solo por empresa) |
| `puesto` | string | Sí | |
| `is_admin` | boolean | No | Default `false` |
| `is_owner` | boolean | No | Default `false` |
| `role_id` | integer | Sí | FK a `roles` (`1=owner`, `2=admin`, `3=usuario` en el seed actual) — no hay endpoint de roles, se cargan por SQL |

`empresa_id` **no va en el body**: siempre se toma del segmento `:empresa_id` de la URL, así que un cliente no puede crear/mover un usuario a otra empresa mandando un `empresa_id` distinto en el JSON.

### `GET /api/usuarios/:empresa_id`

El listado resuelve `rol` por `LEFT JOIN` (si el usuario no tiene `role_id`, `rol` viene `null` en vez de excluir la fila). Responde `404` si la empresa no tiene usuarios.

```json
[
  { "id": 1, "nombre": "Carlos Ramirez", "codigo_ingreso": "CR001", "puesto": "Gerente General", "is_admin": true, "is_owner": true, "empresa_id": 4, "rol": "owner" }
]
```

### `POST /api/usuarios/:empresa_id`

```json
{
  "nombre": "Carlos Ramirez",
  "codigo_ingreso": "CR001",
  "puesto": "Gerente General",
  "is_admin": true,
  "is_owner": true,
  "role_id": 1
}
```

### `PUT /api/usuarios/:empresa_id/:id`

Mismo body que el `POST` (sin `empresa_id`). Responde `404` si el usuario no existe en esa empresa.

### `DELETE /api/usuarios/:empresa_id/:id`

```json
{ "message": "Usuario eliminado exitosamente", "id": "1" }
```

---

## Proveedores

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `nombre` | string | Sí | |
| `telefono` | string | No | |
| `email` | string | No | |
| `domicilio` | string | No | |

`empresa_id` viene de la URL igual que en usuarios.

### `POST /api/proveedores/:empresa_id`

```json
{ "nombre": "Proveedor Central", "telefono": "5551112233", "email": "ventas@proveedorcentral.com", "domicilio": "Zona Industrial 45" }
```

Respuesta `201`:

```json
{
  "message": "Proveedor creado exitosamente",
  "data": { "id": 3, "nombre": "Proveedor Central", "telefono": "5551112233", "email": "ventas@proveedorcentral.com", "empresa_id": 4, "domicilio": "Zona Industrial 45" }
}
```

### `PUT /api/proveedores/:empresa_id/:id`

Mismo body que el `POST`.

### `DELETE /api/proveedores/:empresa_id/:id`

```json
{ "message": "Proveedor eliminado exitosamente", "id": "3" }
```

---

## Productos

Al crear un producto también se crea automáticamente su fila en `inventario` (relación 1 a 1). Al actualizar, ambas tablas se actualizan juntas dentro de la misma transacción.

### Campos del body (`POST` / `PUT`)

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `producto` | string | Sí | Nombre del insumo |
| `stock_actual` | number | Sí | Acepta `0` |
| `stock_minimo` | number | Sí | Acepta `0`; umbral para lista de compras |
| `unidad_medida` | string | Sí | `kg`, `l`, `pza`, etc. |
| `proveedor_id` | integer | Sí | FK a `proveedores` |
| `categoria` | string | Sí | Texto libre |
| `cantidad_presentacion` | number | Sí | Contenido por presentación de compra |
| `costo_presentacion` | number | Sí | Precio de la presentación completa |

`costo_unitario` **no se envía**: es una columna generada por PostgreSQL (`costo_presentacion / cantidad_presentacion`) y siempre viene calculada en la respuesta. `empresa_id` viene de la URL, no del body.

### `GET /api/productos/:empresa_id`

```json
[
  { "id": 33, "producto": "Cholate Sicao", "unidad_medida": "kg", "proveedor_id": 4, "categoria": "Insumos", "empresa_id": 4, "cantidad_presentacion": "1.000", "costo_presentacion": "0.14", "costo_unitario": "0.1400" }
]
```

### `POST /api/productos/:empresa_id`

```json
{
  "producto": "Café molido",
  "stock_actual": 20,
  "stock_minimo": 5,
  "unidad_medida": "kg",
  "proveedor_id": 4,
  "categoria": "Insumos",
  "cantidad_presentacion": 1,
  "costo_presentacion": 150
}
```

Respuesta `201`:

```json
{
  "message": "Producto creado exitosamente",
  "data": {
    "id": 40, "producto": "Café molido", "unidad_medida": "kg", "proveedor_id": 4,
    "categoria": "Insumos", "empresa_id": 4, "cantidad_presentacion": "1.000",
    "costo_presentacion": "150.00", "costo_unitario": "150.0000",
    "stock_actual": "20.000", "stock_minimo": "5.000", "updated_at": "2026-08-10T22:00:00.000Z"
  }
}
```

### `PUT /api/productos/:empresa_id/:id`

Mismo body que el `POST`. Responde `404` si el producto no existe en esa empresa.

> Este `PUT` sobrescribe `stock_actual`/`stock_minimo` directamente y **no queda registrado** en el historial de movimientos. Para ajustes de stock que sí necesiten auditoría (quién, cuándo, por qué), usa `POST /movimientos` en vez de este endpoint.

### `DELETE /api/productos/:empresa_id/:id`

```json
{ "message": "Producto eliminado exitosamente" }
```

Al borrar el producto, su fila de `inventario` se borra en cascada automáticamente (constraint de la BD).

---

## Movimientos de inventario

Registra entradas, salidas y ajustes de stock con trazabilidad completa (usuario, fecha, motivo, stock antes/después). Es el mecanismo recomendado para mover stock en vez de `PUT /productos`.

### Campos del body (`POST`)

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `tipo_movimiento` | string | Sí | Uno de: `COMPRA`, `VENTA`, `MERMA`, `AJUSTE`, `DEVOLUCION`, `PRODUCCION` |
| `cantidad` | number | Sí | Distinta de `0`. Ver reglas de signo abajo |
| `motivo` | string | No | Texto libre para auditoría |
| `usuario_id` | integer | No | Quién hizo el movimiento |
| `costo_unitario` | number | No | Si se omite, toma el `costo_unitario` actual del producto |
| `referencia_tipo` / `referencia_id` | string / integer | No | Para vincular el movimiento a otro registro (ej. una venta o una receta) |

**Dirección sobre el stock:**

| `tipo_movimiento` | Efecto | Signo de `cantidad` |
| --- | --- | --- |
| `COMPRA`, `DEVOLUCION` | Suma al stock | Siempre positiva (se usa su valor absoluto) |
| `VENTA`, `MERMA`, `PRODUCCION` | Resta al stock | Siempre positiva (se usa su valor absoluto) |
| `AJUSTE` | Suma o resta según el signo | Puede ser negativa (ej. `-2` para corregir un conteo físico a la baja) |

Si el movimiento dejaría el stock en negativo, la operación se cancela completa (rollback) y responde `400` con `"Stock insuficiente para este movimiento"`.

### `POST /api/productos/:empresa_id/:id/movimientos`

```json
{ "tipo_movimiento": "COMPRA", "cantidad": 20, "motivo": "Reabastecimiento semanal" }
```

Respuesta `201`:

```json
{
  "message": "Movimiento registrado exitosamente",
  "data": {
    "id": 1, "fecha": "2026-08-10T22:07:21.357Z", "usuario_id": null, "producto_id": 33,
    "tipo_movimiento": "COMPRA", "cantidad": "20.000", "costo_unitario": "0.14",
    "stock_anterior": "1.000", "stock_nuevo": "21.000", "motivo": "Reabastecimiento semanal",
    "referencia_tipo": null, "referencia_id": null
  }
}
```

### `GET /api/productos/:empresa_id/:id/movimientos`

Devuelve el historial del producto, más reciente primero:

```json
[
  { "id": 1, "fecha": "2026-08-10T22:07:21.357Z", "usuario": null, "tipo_movimiento": "COMPRA", "cantidad": "20.000", "stock_anterior": "1.000", "stock_nuevo": "21.000", "motivo": "Reabastecimiento semanal" }
]
```

---

## Inventario (solo lectura)

Vista de solo lectura del stock de todos los productos de una empresa (equivalente a un `GET /productos` pero enfocado en las columnas de stock). Para crear o modificar stock, usa `/productos` o `/productos/:empresa_id/:id/movimientos`.

### `GET /api/inventario/:empresa_id`

```json
[
  { "id": 11, "producto_id": 33, "producto": "Cholate Sicao", "stock_actual": "1.000", "stock_minimo": "4.000", "updated_at": "2026-07-31T15:02:40.691Z" }
]
```

### `GET /api/inventario/:empresa_id/:id`

`:id` es el `id` de la fila de `inventario` (no el `producto_id`).

---

## Recetas

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `nombre` | string | Sí | |
| `categoria` | string | Sí | |
| `precio_venta` | number | Sí (o usa el default `0`) | |
| `costo_total` | number | No | Valor inicial; se **recalcula automáticamente** como la suma de `costo_final` de sus ingredientes cada vez que se agrega, edita o borra un detalle |
| `activo` | boolean | No | |

`margen` no se envía: es una columna generada (`(precio_venta - costo_total) / precio_venta * 100`).

### `POST /api/recetas/:empresa_id`

```json
{ "nombre": "Hamburguesa BBQ", "categoria": "Plato fuerte", "precio_venta": 189, "costo_total": 0, "activo": true }
```

Respuesta `201`: la fila completa de la receta, incluido `margen` calculado.

### `PUT /api/recetas/:empresa_id/:id`

Mismo body. Responde `404` si la receta no existe en esa empresa.

### `DELETE /api/recetas/:empresa_id/:id`

```json
{ "message": "Receta eliminada correctamente" }
```

---

## Detalle de receta (ingredientes)

Cada fila conecta una receta con un producto (ingrediente) y su cantidad. **No lleva `:empresa_id` en la URL** — la ruta cuelga de `:receta_id` (que ya pertenece a una empresa), y el backend valida en la propia query que el `producto_id` enviado pertenezca a la **misma empresa** que la receta; si no, responde `404` en vez de mezclar productos entre empresas.

### Campos del body

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `producto_id` | integer | Sí | Debe pertenecer a la misma empresa que la receta |
| `cantidad` | number | Sí | |

`costo_unitario` se copia automáticamente del producto al momento de crear/editar el detalle (snapshot histórico), y `costo_final` es una columna generada (`cantidad * costo_unitario`).

### `POST /api/recetas/:receta_id/detalle`

```json
{ "producto_id": 33, "cantidad": 3 }
```

Respuesta `201`:

```json
{ "id": 32, "receta_id": 1, "producto": "Cholate Sicao", "cantidad": "3.000", "costo_unitario": "0.1400", "costo_final": "0.42" }
```

Si `producto_id` no existe o pertenece a otra empresa, responde `404` con `{"error": "Producto no encontrado"}` y la receta padre recalcula su `costo_total` automáticamente tras la operación.

### `PUT /api/recetas/:receta_id/detalle/:id`

```json
{ "producto_id": 33, "cantidad": 10 }
```

### `DELETE /api/recetas/:receta_id/detalle/:id`

```json
{ "message": "Detalle de receta eliminado correctamente" }
```

---

## Flujo de pruebas recomendado

```bash
# 1. Empresa
curl -X POST http://localhost:4000/api/empresas \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Café Aroma","titular":"Carlos Ramirez","telefono":"5551234567","email":"contacto@cafearoma.com","domicilio":"Av. Principal 123"}'

# 2. Roles: insertar por SQL, no hay endpoint
#    INSERT INTO roles (nombre) VALUES ('owner'), ('admin'), ('usuario');

# 3. Usuario (empresa_id = 4, ajusta al id real que te devolvió el paso 1)
curl -X POST http://localhost:4000/api/usuarios/4 \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Carlos Ramirez","codigo_ingreso":"CR001","puesto":"Gerente General","is_admin":true,"is_owner":true,"role_id":1}'

# 4. Proveedor
curl -X POST http://localhost:4000/api/proveedores/4 \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Proveedor Central","telefono":"5551112233","email":"ventas@proveedorcentral.com"}'

# 5. Producto (usa el proveedor_id real del paso 4)
curl -X POST http://localhost:4000/api/productos/4 \
  -H "Content-Type: application/json" \
  -d '{"producto":"Café molido","stock_actual":20,"stock_minimo":5,"unidad_medida":"kg","proveedor_id":1,"categoria":"Insumos","cantidad_presentacion":1,"costo_presentacion":150}'

# 6. Movimiento de stock (usa el id del producto del paso 5)
curl -X POST http://localhost:4000/api/productos/4/1/movimientos \
  -H "Content-Type: application/json" \
  -d '{"tipo_movimiento":"COMPRA","cantidad":10,"motivo":"Reabastecimiento"}'

# 7. Receta
curl -X POST http://localhost:4000/api/recetas/4 \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Café americano","categoria":"Bebida","precio_venta":45,"activo":true}'

# 8. Ingrediente de la receta (usa el id de la receta del paso 7 y el producto del paso 5)
curl -X POST http://localhost:4000/api/recetas/1/detalle \
  -H "Content-Type: application/json" \
  -d '{"producto_id":1,"cantidad":0.02}'
```


---

## Formato de respuesta estándar (v2)

> **Importante:** desde la v2, **todas** las respuestas usan un sobre uniforme. Los ejemplos por endpoint de arriba muestran el contenido de `data`.

Éxito:

```json
{ "success": true, "data": { } }
```

Los listados devuelven `data` como arreglo. Las operaciones sin cuerpo (p. ej. borrado) devuelven `{ "success": true, "message": "..." }`.

Error:

```json
{ "success": false, "error": "Mensaje legible" }
```

Errores de validación (zod) → **400** con detalle por campo:

```json
{
  "success": false,
  "error": "Validación fallida",
  "details": [ { "campo": "nombre", "mensaje": "nombre es requerido" } ]
}
```

Los errores de base de datos se traducen a mensajes limpios (nunca se expone SQL). Lo inesperado → `500 { "success": false, "error": "Error interno del servidor" }`.

### Validación de entrada

Los endpoints de escritura (POST/PUT) validan el cuerpo con **zod** antes de tocar la base. Reglas clave: cantidades > 0, precios >= 0, `tipo_movimiento` en {COMPRA, VENTA, MERMA, AJUSTE, DEVOLUCION, PRODUCCION}, `tipo` de pos_map en {RECETA, INSUMO, IGNORAR}, `fecha` con formato `YYYY-MM-DD`. Se aceptan numeros como string ("50" -> 50).

---

## Endpoints nuevos (v2)

### Recetas — costeo y creacion con escandallo

`recetas` ahora incluye `costo_produccion` y `proteccion_pct` (default 0). `costo_total` lo calcula el backend con la formula unica:
`costo_total = (suma de costo_final de ingredientes + costo_produccion) * (1 + proteccion_pct / 100)`; `margen` se deriva de `costo_total` y `precio_venta`.

`POST /api/recetas/:empresa_id` acepta la receta con su escandallo en un solo cuerpo:

```json
{
  "nombre": "Turco Arrachera",
  "categoria": "Plato fuerte",
  "precio_venta": 155,
  "activo": true,
  "costo_produccion": 5,
  "proteccion_pct": 10,
  "ingredientes": [ { "producto_id": 137, "cantidad": 100 } ]
}
```

Sin `ingredientes`, crea solo el encabezado. El `PUT /api/recetas/:empresa_id/:id` actualiza el encabezado y recalcula el costo.

`POST /api/recetas/:empresa_id/preview` — calcula costo y margen **sin guardar** (para el calculo en vivo del front). Cuerpo: `{ precio_venta?, costo_produccion?, proteccion_pct?, ingredientes:[{producto_id, cantidad}] }`. Devuelve `suma_insumos`, `costo_total`, `margen` y el detalle.

### Detalle de receta

`POST /api/recetas/:receta_id/detalle` con `{ producto_id, cantidad }` agrega un ingrediente suelto y recalcula `costo_total`.

### PosMap — mapeo POS (Toteat) a recetas/insumos

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/api/pos-map/:empresa_id` | Listar mapeos |
| POST | `/api/pos-map/:empresa_id` | Crear/actualizar (upsert por nombre) |
| POST | `/api/pos-map/:empresa_id/bulk` | Carga masiva (arreglo o `{ "mapeos": [...] }`) |
| PUT | `/api/pos-map/:empresa_id/:id` | Editar |
| DELETE | `/api/pos-map/:empresa_id/:id` | Borrar |

Cuerpo: `{ "nombre_pos": "...", "tipo": "RECETA|INSUMO|IGNORAR", "receta_id": n, "producto_id": n, "factor": 1 }` (segun `tipo`: RECETA usa `receta_id`, INSUMO usa `producto_id`, IGNORAR ninguno).

### Ventas — importacion diaria

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| POST | `/api/ventas/:empresa_id/importar` | Importa el mix de ventas y descuenta insumos |
| GET | `/api/ventas/:empresa_id/:fecha` | Consulta el dia y sus movimientos |
| DELETE | `/api/ventas/:empresa_id/:fecha` | Revierte el dia (registra DEVOLUCION y libera la fecha) |

`importar` acepta `{ "fecha": "YYYY-MM-DD", "lineas": [{ "nombre_pos", "cantidad" }] }` **o** `{ "fecha": "YYYY-MM-DD", "csv": "<CSV de Toteat>" }`. Un dia ya importado devuelve **409**.

---

## Paginación (v2)

Los listados que pueden crecer aceptan `?limit=&offset=` y devuelven metadatos:

- Endpoints: `GET /api/productos/:empresa_id`, `GET /api/recetas/:empresa_id`, `GET /api/productos/:empresa_id/:id/movimientos`.
- Defaults: `limit=50` (máx `200`), `offset=0`.
- Respuesta:

```json
{ "success": true, "data": [ ], "pagination": { "limit": 50, "offset": 0, "total": 123 } }
```

Los listados de baja cardinalidad (inventario, proveedores, usuarios, pos-map, empresas) no se paginan por diseño; agregar `limit/offset` ahí es trivial con el mismo helper `parsePagination` si algún día hace falta.
