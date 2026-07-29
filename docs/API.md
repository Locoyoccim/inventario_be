# Referencia de API — Inventario Backend

API REST para gestionar **empresas, usuarios, proveedores y productos**.

---

## Información general

| Concepto | Valor |
| --- | --- |
| URL base | `http://localhost:4000` |
| Prefijo de rutas | `/api` |
| Ejemplo | `http://localhost:4000/api/usuarios` |
| Formato | JSON |
| Header requerido (con body) | `Content-Type: application/json` |
| Autenticación | **Ninguna** — todos los endpoints son públicos |

> ⚠️ No hay filtro por `empresa_id` en los listados. Todo `GET` de colección devuelve registros de todas las empresas.

### Códigos de respuesta

| Código | Significado |
| --- | --- |
| `200` | Solicitud exitosa |
| `201` | Recurso creado |
| `400` | Datos inválidos o campos requeridos faltantes |
| `404` | Recurso no encontrado |
| `500` | Error interno del servidor o error SQL |

---

## Mapa de endpoints

| Módulo | Método | Ruta | Descripción |
| --- | --- | --- | --- |
| Empresas | `GET` | `/api/empresas` | Listar empresas |
| Empresas | `GET` | `/api/empresas/:id` | Obtener empresa |
| Empresas | `POST` | `/api/empresas` | Crear empresa |
| Empresas | `PUT` | `/api/empresas/:id` | Actualizar empresa |
| Empresas | `DELETE` | `/api/empresas/:id` | Eliminar empresa |
| Usuarios | `GET` | `/api/usuarios` | Listar usuarios |
| Usuarios | `GET` | `/api/usuarios/:id` | Obtener usuario |
| Usuarios | `POST` | `/api/usuarios` | Crear usuario |
| Usuarios | `PUT` | `/api/usuarios/:id` | Actualizar usuario |
| Usuarios | `DELETE` | `/api/usuarios/:id` | Eliminar usuario |
| Proveedores | `GET` | `/api/proveedores` | Listar proveedores |
| Proveedores | `GET` | `/api/proveedores/:id` | Obtener proveedor |
| Proveedores | `POST` | `/api/proveedores` | Crear proveedor ⚠️ |
| Proveedores | `PUT` | `/api/proveedores/:id` | Actualizar proveedor ⚠️ |
| Proveedores | `DELETE` | `/api/proveedores/:id` | Eliminar proveedor ⚠️ |
| Productos | `GET` | `/api/productos` | Listar productos |
| Productos | `GET` | `/api/productos/:id` | Obtener producto |
| Productos | `POST` | `/api/productos` | Crear producto |
| Productos | `PUT` | `/api/productos/:id` | Actualizar producto |
| Productos | `DELETE` | `/api/productos/:id` | Eliminar producto |

⚠️ = tiene bugs conocidos, ver la sección final.

---

## Empresas

Entidad raíz. Debe crearse antes que cualquier otro recurso.

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `id` | integer | auto | Generado por la BD |
| `nombre` | string | Sí | Razón social o nombre comercial |
| `titular` | string | Sí | Responsable de la cuenta |
| `telefono` | string | Sí | Se guarda como texto |
| `email` | string | Sí | |
| `domicilio` | string | Sí | |

### `GET /api/empresas`

```json
[
  {
    "id": 1,
    "nombre": "CotiPro Solutions",
    "titular": "Carlos Ramirez",
    "telefono": "5551234567",
    "email": "contacto@cotipro.com",
    "domicilio": "Av. Principal 123"
  }
]
```

### `POST /api/empresas`

Body:

```json
{
  "nombre": "CotiPro Solutions",
  "titular": "Carlos Ramirez",
  "telefono": "5551234567",
  "email": "contacto@cotipro.com",
  "domicilio": "Av. Principal 123, Ciudad de Mexico"
}
```

Respuesta `201`:

```json
{
  "message": "Empresa creada exitosamente",
  "data": {
    "id": 1,
    "nombre": "CotiPro Solutions",
    "titular": "Carlos Ramirez",
    "telefono": "5551234567",
    "email": "contacto@cotipro.com",
    "domicilio": "Av. Principal 123, Ciudad de Mexico"
  }
}
```

### `PUT /api/empresas/:id`

Mismo body que el `POST`. Reemplaza todos los campos enviados.

### `DELETE /api/empresas/:id`

```json
{ "message": "Empresa eliminada exitosamente", "id": "1" }
```

---

## Usuarios

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `nombre` | string | Sí | |
| `codigo_ingreso` | string | Sí | Código de acceso del empleado; debería ser único |
| `puesto` | string | Sí | Texto libre |
| `is_admin` | boolean | No | Default `false` |
| `is_owner` | boolean | No | Default `false` |
| `role_id` | integer | Sí | FK a `roles` — cargar la tabla por SQL |
| `empresa_id` | integer | Sí | FK a `empresas` |

### `GET /api/usuarios`

El listado devuelve `rol` y `empresa` resueltos por `JOIN` (no devuelve `role_id`):

```json
[
  {
    "id": 1,
    "nombre": "Carlos Ramirez",
    "codigo_ingreso": "CR001",
    "puesto": "Gerente General",
    "is_admin": true,
    "is_owner": true,
    "empresa_id": 1,
    "rol": "owner",
    "empresa": "CotiPro Solutions"
  }
]
```

### `POST /api/usuarios`

```json
{
  "nombre": "Carlos Ramirez",
  "codigo_ingreso": "CR001",
  "puesto": "Gerente General",
  "is_admin": true,
  "is_owner": true,
  "role_id": 1,
  "empresa_id": 1
}
```

Respuesta `201`:

```json
{
  "message": "Usuario creado exitosamente",
  "data": {
    "id": 1,
    "nombre": "Carlos Ramirez",
    "codigo_ingreso": "CR001",
    "puesto": "Gerente General",
    "is_admin": true,
    "is_owner": true,
    "role_id": 1,
    "empresa_id": 1
  }
}
```

### `PUT /api/usuarios/:id`

```json
{
  "nombre": "Carlos Ramirez",
  "codigo_ingreso": "CR002",
  "puesto": "Administrador",
  "is_admin": true,
  "is_owner": false,
  "role_id": 2,
  "empresa_id": 1
}
```

Respuesta: `{ "message": "Usuario actualizado exitosamente", "data": { ... } }`

### `DELETE /api/usuarios/:id`

```json
{ "message": "Usuario eliminado exitosamente", "id": "1" }
```

---

## Proveedores

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `nombre` | string | Sí | |
| `contacto` | string | ⚠️ | El repository lo envía, el SQL no lo declara → ver BUG-03 |
| `telefono` | string | Sí | |
| `email` | string | Sí | |
| `empresa_id` | integer | Sí | FK a `empresas` |

### `GET /api/proveedores`

```json
[
  {
    "id": 1,
    "nombre": "Proveedor Central",
    "telefono": "5551112233",
    "email": "ventas@proveedorcentral.com",
    "empresa_id": 1,
    "empresa": "CotiPro Solutions"
  }
]
```

### `POST /api/proveedores`

```json
{
  "nombre": "Proveedor Central",
  "contacto": "Laura Martinez",
  "telefono": "5551112233",
  "email": "ventas@proveedorcentral.com",
  "empresa_id": 1
}
```

Respuesta esperada `201`:

```json
{
  "message": "Proveedor creado exitosamente",
  "data": {
    "id": 1,
    "nombre": "Proveedor Central",
    "telefono": "5551112233",
    "email": "ventas@proveedorcentral.com",
    "empresa_id": 1
  }
}
```

> ⚠️ En el estado actual del código esta petición falla: el `INSERT` declara 4 columnas pero se envían 5 valores. `contacto` no persiste ni se regresa.

### `PUT /api/proveedores/:id`

Mismo body que el `POST`. ⚠️ Falla por el mismo desajuste de parámetros (4 campos + `id` contra 6 valores).

### `DELETE /api/proveedores/:id`

```json
{ "message": "Proveedor eliminado exitosamente", "id": "1" }
```

> ⚠️ Falla: el SQL usa `?` como placeholder y `pg` requiere `$1`.

---

## Productos

### Campos

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `producto` | string | Sí | Nombre del insumo |
| `stock_actual` | number | Sí | ⚠️ El valor `0` es rechazado por la validación actual |
| `stock_minimo` | number | Sí | Umbral para lista de compras; `0` también se rechaza |
| `unidad_medida` | string | Sí | `kg`, `l`, `pza`, etc. |
| `proveedor_id` | integer | Sí | FK a `proveedores` |
| `categoria` | string | Sí | Texto libre |
| `empresa_id` | integer | Sí | FK a `empresas` |
| `cantidad_presentacion` | number | Sí | Contenido por presentación de compra |
| `costo_presentacion` | number | Sí | Precio de la presentación completa |
| `costo_unitario` | number | Sí | Debería ser `costo_presentacion / cantidad_presentacion` — hoy se envía a mano y puede desincronizarse |

### `GET /api/productos`

```json
[
  {
    "id": 1,
    "producto": "Cafe molido",
    "stock_actual": 20,
    "stock_minimo": 5,
    "unidad_medida": "kg",
    "proveedor_id": 1,
    "categoria": "Insumos",
    "empresa_id": 1,
    "cantidad_presentacion": 1,
    "costo_presentacion": 150,
    "costo_unitario": 150
  }
]
```

### `POST /api/productos`

Body con todos los campos de la tabla anterior. Respuesta `201`:

```json
{
  "message": "Producto creado exitosamente",
  "data": { "id": 1, "producto": "Cafe molido", "...": "..." }
}
```

### `PUT /api/productos/:id`

```json
{
  "producto": "Cafe molido premium",
  "stock_actual": 30,
  "stock_minimo": 8,
  "unidad_medida": "kg",
  "proveedor_id": 1,
  "categoria": "Insumos",
  "empresa_id": 1,
  "cantidad_presentacion": 1,
  "costo_presentacion": 180,
  "costo_unitario": 180
}
```

> Este `PUT` es también el único mecanismo para mover stock: sobrescribe `stock_actual` sin dejar registro del movimiento.

### `DELETE /api/productos/:id`

```json
{ "message": "Producto eliminado exitosamente" }
```

> ⚠️ Inconsistente con los demás módulos: no regresa `id`.

---

## Flujo de pruebas recomendado

```bash
# 1. Empresa
curl -X POST http://localhost:4000/api/empresas \
  -H "Content-Type: application/json" \
  -d '{"nombre":"CotiPro Solutions","titular":"Carlos Ramirez","telefono":"5551234567","email":"contacto@cotipro.com","domicilio":"Av. Principal 123"}'

# 2. Roles: insertar por SQL, no hay endpoint
#    INSERT INTO roles (nombre) VALUES ('owner'), ('admin'), ('empleado');

# 3. Usuario
curl -X POST http://localhost:4000/api/usuarios \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Carlos Ramirez","codigo_ingreso":"CR001","puesto":"Gerente General","is_admin":true,"is_owner":true,"role_id":1,"empresa_id":1}'

# 4. Proveedor
curl -X POST http://localhost:4000/api/proveedores \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Proveedor Central","contacto":"Laura Martinez","telefono":"5551112233","email":"ventas@proveedorcentral.com","empresa_id":1}'

# 5. Producto
curl -X POST http://localhost:4000/api/productos \
  -H "Content-Type: application/json" \
  -d '{"producto":"Cafe molido","stock_actual":20,"stock_minimo":5,"unidad_medida":"kg","proveedor_id":1,"categoria":"Insumos","empresa_id":1,"cantidad_presentacion":1,"costo_presentacion":150,"costo_unitario":150}'
```

---

## Bugs conocidos que afectan estos endpoints

| ID | Endpoint afectado | Problema |
| --- | --- | --- |
| BUG-01 | `DELETE /api/productos/:id` | El `catch` usa `throw new error(...)` en minúscula → `TypeError` que oculta el error real |
| BUG-02 | `POST`/`PUT /api/productos` | Validación `!campo` rechaza `0` en stock y costos |
| BUG-03 | `POST /api/proveedores` | `INSERT` con 4 columnas y 5 valores |
| BUG-04 | `PUT /api/proveedores/:id` | `UPDATE` con 4 campos + `id` y 6 valores |
| BUG-05 | `DELETE /api/proveedores/:id` | Placeholder `?` en vez de `$1` |

Detalle y prioridad de corrección en el README, sección *Estado actual y deuda técnica*.
