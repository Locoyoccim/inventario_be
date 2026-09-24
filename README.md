# Inventario App — Backend

Sistema de control de inventario, recetas y costos **multiempresa** para negocios de alimentos y bebidas (cafeterías, restaurantes). API REST en Node.js + Express 5 sobre PostgreSQL, por capas (`routes → controller → service → repository/logic`), con inyección de dependencias centralizada (`src/container.js`).

> **Estado:** backend funcional y probado (unitarias + integración HTTP). Autenticación JWT, roles, costeo con cascada, compras, producción, conteos, ventas y reportes están implementados. Pendiente: frontend (se desarrolla aparte) y despliegue en Railway.

---

## 1. Alcance real (qué existe hoy)

| Módulo / Capacidad | Estado | Nota |
| --- | --- | --- |
| Autenticación (JWT + cookie httpOnly) | ✅ | `login`/`setup`/`logout`/`me`; token 7 días; anti-CSRF con cookie |
| Roles (Admin / Operativo) | ✅ | Admin = `is_admin` o `is_owner`; Operativo = ventas, conteos, compras, producción + lecturas |
| Revocación de sesión | ✅ | `token_version` en el JWT: `logout-all` y cierre forzado por admin |
| Empresas (CRUD) | ✅ | `POST` protegido con `PLATFORM_TOKEN`; `DELETE` solo dueño |
| Usuarios (CRUD) | ✅ | Soft-delete (`activo`); `codigo_ingreso` único **por empresa** |
| Proveedores (CRUD) | ✅ | Soft-delete (`activo`); no se puede referenciar uno inactivo |
| Categorías (CRUD) | ✅ | Lista compartida por empresa (productos + recetas) |
| Productos (CRUD) | ✅ | Crea/edita con su fila de `inventario`; soft-delete; filtros y paginación |
| Inventario | ✅ (lectura) | El stock solo cambia por movimientos/compras/producción/conteos |
| Movimientos (kardex) | ✅ | Compra, venta, merma, ajuste, devolución, producción; costo a 4 decimales |
| Recetas y preparaciones | ✅ | `costo_total` recalculado; sub-recetas (elaborados) y **cascada de costos** |
| Producción | ✅ | Consume insumos y produce elaborados en una transacción |
| Compras | ✅ | Último costo; actualiza costo y dispara la cascada de recetas |
| Conteo físico | ✅ | Varianza teórico vs. real y reconciliación con ajustes |
| PosMap + Ventas (importación diaria) | ✅ | Mapea el POS a recetas/insumos; importa/rev­ierte; listado y preview |
| Reportes | ✅ | Estado del día, valorización, alertas, actividad, consumo |

Aislamiento multiempresa: cada recurso lleva `:empresa_id` en la URL y se valida contra el token; los repositories filtran por empresa (directo o vía `JOIN`). Un `id` de otra empresa responde `403`/`404`, nunca datos ajenos.

---

## 2. Stack

- **Runtime:** Node.js 18+ (probado en 22)
- **Framework:** Express 5
- **Base de datos:** PostgreSQL 14+ (`pg`, SQL crudo — sin ORM). Migraciones propias en `db/migrations` (`npm run migrate`).
- **Auth:** `jsonwebtoken` (JWT) + `bcryptjs`; cookie httpOnly de sesión.
- **Validación:** `zod` en middleware por ruta.
- **Seguridad de borde:** `helmet`, `express-rate-limit`, límite de body, CORS con credenciales, validación de entorno al arrancar.
- **Pruebas:** `node:test` nativo (cero dependencias). Integración HTTP guardada por `TEST_DATABASE_URL`.
- **CI:** GitHub Actions con servicio Postgres 16.

---

## 3. Instalación

```bash
git clone <repo>
cd inventario_BE
npm install
```

Crea `.env` (usa `.env.example` como plantilla):

```env
# Base de datos: DATABASE_URL (Railway) O las variables DB_*
DATABASE_URL=postgresql://usuario:pass@host:5432/inventario_db
# DB_USER=postgres
# DB_HOST=127.0.0.1
# DB_NAME=inventario_db
# DB_PASSWORD=tu_password
# DB_PORT=5432

JWT_SECRET=un_secreto_de_al_menos_32_caracteres_aqui
PORT=4000
# Producción: obligatorios
# CORS_ORIGINS=https://app.tu-dominio.mx
# SETUP_TOKEN=...          # exige header x-setup-token en /setup
# PLATFORM_TOKEN=...       # exige header x-platform-token en POST /empresas
```

Aplica migraciones y levanta:

```bash
npm run migrate      # crea/actualiza el esquema
npm run dev          # o: npm start
```

La configuración crítica se valida al arrancar (`src/config/env.js`): si falta `JWT_SECRET` (32+), la BD, o `CORS_ORIGINS`/`SETUP_TOKEN` en producción, el proceso aborta con un mensaje claro.

### Primer usuario

Con la BD migrada, crea el dueño con `POST /api/auth/setup` (solo funciona si no existe ningún usuario). Después, entra con `POST /api/auth/login`.

### Variables de entorno

| Variable | Requerida | Default | Descripción |
| --- | --- | --- | --- |
| `DATABASE_URL` | Sí* | — | Cadena de conexión (o usa `DB_*`) |
| `DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT` | Sí* | — | Alternativa a `DATABASE_URL` |
| `JWT_SECRET` | Sí | — | 32+ caracteres |
| `JWT_EXPIRES` | No | `7d` | Vigencia del token |
| `PORT` | No | `4000` | Puerto del servidor |
| `CORS_ORIGINS` | Prod | — | Lista separada por comas |
| `SETUP_TOKEN` | Prod | — | Protege `/auth/setup` |
| `PLATFORM_TOKEN` | Prod | — | Protege `POST /empresas` |
| `DB_SSL` | No | — | `require` para SSL sin verificar cert |

\* Se requiere `DATABASE_URL` **o** el conjunto `DB_*`.

---

## 4. Estructura

```
inventario_BE/
├── src/
│   ├── config/       # db.js (pool + timeouts), env.js (validación de entorno)
│   ├── modules/      # dominio: auth, empresas, usuarios, proveedores, categorias,
│   │                 #   productos, inventario, movimientos, recetas, recetaDetalle,
│   │                 #   produccion, compras, conteos, posMap, ventas, reportes
│   ├── routes/       # una ruta por recurso + index.js (agregador con guards)
│   ├── middlewares/  # auth, activeUser, validate, errorHandler, ...
│   ├── utils/        # jwt, costeo, parseToteat, ...
│   ├── container.js  # inyección de dependencias
│   └── app.js        # Express (helmet, cors, rate-limit, /health, rutas, errores)
├── db/migrations/    # migraciones SQL versionadas
├── docs/             # API.md + colección Postman
├── test/             # unitarias + test/integration (guardadas por TEST_DATABASE_URL)
└── server.js         # entrada: valida env, listen, cierre ordenado
```

---

## 5. Autenticación y roles

- El token va en cookie httpOnly `gh_session` (front web) o en `Authorization: Bearer <token>` (Postman/integraciones). Con cookie, toda escritura exige además el header `X-Requested-With` (anti-CSRF).
- **Admin** (`is_admin` o `is_owner`): todo. **Operativo**: registra ventas, conteos, compras y confirma producción, además de leer; no crea/edita catálogos (productos, recetas, proveedores, usuarios, pos-map, categorías) → `403`.
- El rol se **revalida desde la BD** en cada request (caché 60s): un usuario degradado o desactivado pierde permisos sin esperar a que expire el token.
- **Revocación:** `token_version` viaja en el JWT. `POST /auth/logout-all` cierra todas las sesiones del usuario; el `PUT` de usuarios con `forzar_cierre_sesion: true` fuerza el cierre de otro usuario. El `logout` normal solo cierra el dispositivo actual.

---

## 6. Seguridad de borde

- `helmet`, CORS con credenciales (lista `CORS_ORIGINS`), body ≤ 100 KB.
- Rate limit: 10/min en `login`/`setup`, 300/min en el resto de `/api`.
- `/health` (liveness, sin BD) y `/health/ready` (readiness, hace `SELECT 1` → 503 si la BD falla).
- Pool con `statement_timeout`, `connectionTimeoutMillis` y `pool.on('error')`; cierre ordenado en `SIGTERM`/`SIGINT`.
- Errores centralizados (`errorHandler`): los códigos de Postgres se mapean a HTTP limpios; nunca se filtra SQL crudo.

---

## 7. Modelo de datos (calculadas por PostgreSQL)

| Tabla | Columna | Fórmula |
| --- | --- | --- |
| `productos` | `costo_unitario` `numeric(10,4)` | `costo_presentacion / cantidad_presentacion` |
| `recetas` | `margen` | `(precio_venta - costo_total) / precio_venta * 100` |
| `receta_detalle` | `costo_final` | `cantidad * costo_unitario` |
| `conteo_detalle` | `variacion`, `valor_variacion` | derivadas del conteo |

`costo_presentacion` es `numeric(12,4)` (insumos de presentación chica conservan el costo real, ej. `0.0123`). `recetas.costo_total` la recalcula el backend a partir de sus `receta_detalle`, y con **cascada**: al cambiar el costo de un insumo (compra o edición) o de una preparación, se refrescan todas las recetas que lo usan.

---

## 8. Migraciones

Versionadas en `db/migrations/NNN_*.sql`, aplicadas en orden por `npm run migrate` (registra lo aplicado en `schema_migrations`; idempotente). El baseline funciona sobre una base vacía. Estado: `npm run migrate:status`.

---

## 9. Pruebas

```bash
npm test                    # unitarias (node:test), no tocan la BD
# Integración HTTP (requiere una BD de prueba migrada):
TEST_DATABASE_URL=postgres://... npm test
```

La suite de integración (`test/integration/http.test.js`) levanta la app en un puerto efímero y ejerce los flujos reales (compras con cascada y 4 decimales, ventas import/409/revert, producción, conteos, guardado atómico de recetas, soft-delete de proveedores) y la matriz de permisos (Admin vs Operativo vs otra empresa). Sin `TEST_DATABASE_URL` se salta.

---

## 10. Documentación de API

Referencia por endpoint con cuerpos y ejemplos: **[docs/API.md](docs/API.md)**. Colección Postman: `docs/postman_collection.json` (el login guarda el token). También hay una versión en Notion.

---

## 11. Deuda técnica pendiente (por prioridad)

| Tema | Nota |
| --- | --- |
| Costeo multinivel de preparaciones | Las preparaciones mantienen `costo_total` a 2 decimales (la precisión por unidad se preserva vía `costo_unitario`). |
| Fechas a `timestamptz` | Hoy las columnas de fecha/hora son `timestamp`/`date` sin zona. Migración planeada aparte. |
| Revocación por sesión | `token_version` revoca **todas** las sesiones del usuario; no hay revocación de un solo dispositivo (requeriría lista de tokens). |
| Reportes avanzados | Ampliar más allá de estado/inventario/alertas/actividad/consumo según lo pida el front. |

---

## 12. Convenciones

- `Content-Type: application/json` en toda petición con body.
- Campos en `snake_case`, en español, alineados con la BD.
- Sobre de respuesta: éxito `{ success: true, data }` · error `{ success: false, error }`; los listados agregan `pagination`.
- Códigos: `200/201` · `400` datos/regla · `401` sin sesión · `403` empresa/rol · `404` no encontrado · `409` conflicto · `413` body grande · `429` rate limit · `500` interno.
- `empresa_id` siempre en la URL, nunca en el body.

---

## 13. Licencia

Proyecto bajo licencia **MIT**.
