# Revisión manual del SQL multiempresa (Fase 5)

Complementa `test/tenant-sql.baseline.json` (el detalle consulta por consulta) y la prueba C
(`test/integration/aislamiento-sql.test.js`). Fecha de la revisión: 2026-10-08.

## Qué se revisó y cómo

1. `test/helpers/escanerSql.js` extrae de `src/` todos los literales SQL (cadenas y plantillas que empiezan por
   `SELECT/INSERT/UPDATE/DELETE/WITH`), resuelve las constantes de texto del mismo archivo (`${RENGLONES_COBRADOS}`) y,
   con el esquema real de la base, determina qué tablas toca cada uno.
2. Una consulta **«filtra por empresa»** si `empresa_id` aparece como condición (`= … IN … ANY`) o como columna de un
   `INSERT`. Mencionarlo solo en el `SELECT` no cuenta.
3. Quedan **pendientes de revisión** las que tocan una tabla con `empresa_id` sin filtrarla, y las que tocan solo tablas
   hijas (sin `empresa_id`). Para cada una se leyó el código que la rodea: quién la invoca, de dónde sale cada id y cuál es
   la comprobación previa de pertenencia. Una herramienta automática ayudó a localizar esa comprobación previa; **no se
   confió en ella** (descubrió coincidencias espurias en las constantes `QUERIES = {…}`, que se resolvieron a mano).

## Cifras

| | |
|---|---|
| Literales SQL en `src/` | 475 |
| Tocan una tabla del esquema | 470 |
| …de ellos, tocan una tabla con `empresa_id` | 432 |
| …y **filtran** por empresa | 300 |
| Sin filtro (a revisar) | 132 |
| Solo tablas hijas (a revisar) | 20 |
| **Total revisado** | **152 ocurrencias en 141 consultas distintas** |

La auditoría original hablaba de «122»: eran las consultas que no *mencionaban* `empresa_id`. Con el criterio más estricto
(que lo usen como filtro) y contando las tablas hijas, la cifra real a revisar es 152.

## Resultado

**Ninguna de las 152 permite leer ni modificar datos de otra empresa.** Todas son una de estas cosas
(categorías del baseline):

- **segundo paso tras una guardia** (90): el método ya filtró por empresa (`#bloquear`, `#cuentaAbierta`,
  `#itemPendiente`, `LOCK_PRODUCTO`, `Q.TURNO`, `FETCH_ANULAR_LOCK`…) y actúa sobre esa fila o sus ids;
- **hija por padre verificado** (13): tablas sin `empresa_id` alcanzadas desde un padre ya verificado;
- **ids verificados por el llamador** (14): funciones auxiliares que solo reciben ids ya validados;
- **listado con WHERE dinámico** (9): el SELECT base lleva el filtro de empresa en el WHERE que arma el método;
- **identidad del agente o del equipo** (7) y **por credencial previa a la sesión** (2): el secreto fija la empresa;
- **la propia guardia** (2), **mantenimiento o global** (3) y **depende de guardia de ruta** (1, ver O1).

## Observaciones (no son fugas)

| | Dónde | Qué | Recomendación |
|---|---|---|---|
| O1 | `recetas/receta.repository.js` `detalle()` | No filtra por empresa; depende de `router.param("receta_id", recetaEmpresaGuard)`. Único llamador: `GET /recetas/:receta_id/detalle`. | Filtrar también en SQL (`JOIN recetas … AND empresa_id = $2`). |
| O2 | `recetas/receta.repository.js` `EXISTS_RECETA` / `existsReceta()` | Consulta global (`WHERE id = $1`) **sin ningún llamador**. | Borrar (código muerto; si se usara revelaría existencia entre empresas). |
| O3 | `dispositivos/dispositivo.repository.js` `fallosRecientes()` | El contador por IP no filtra por empresa: dos empresas detrás de la misma IP comparten el enfriamiento anti fuerza bruta. No expone datos. | Aceptado por diseño; documentar. |
| O4 | `recetas/receta.repository.js` `#reemplazarEscandallo()` | Su `SELECT … empresa_id` interno no aborta si la receta es ajena; la protección está en `create()` y `update()`. | Hacer que aborte (defensa en profundidad). |
| O5 | `utils/costeo.js` `propagarCostoInsumos()` | Actualiza `receta_detalle` por producto en cualquier receta; seguro porque al escribir se exige «ingrediente de la misma empresa». | `npm run audit:tenant` comprueba ese invariante en los datos. |
| O6 | `GET /productos/:e/:id/movimientos` | Con un producto de otra empresa responde 200 con lista vacía (el kardex se filtra por empresa) en vez de 404. No revela ni cambia nada. | Responder 404 por consistencia. |
| O7 | 11 tablas sin `empresa_id` | Su aislamiento depende de la clave foránea del padre (ADR-001). | Sin cambios estructurales en esta fase. |

## Límites de este método

- Solo ve **literales** SQL: el SQL armado en tiempo de ejecución (concatenación, `where.push(...)`) no se analiza. Se revisó
  a mano en los listados (`finanzas`, `compras`, `movimientos`, `productos`, `recetas`, `reservaciones`): todos empiezan el
  `WHERE` por la condición de empresa.
- Comprueba que `empresa_id` esté **presente como filtro**, no que sea el correcto. Esa garantía la dan las pruebas
  dinámicas A/B (`aislamiento-rutas`, `aislamiento-dinamico`, `aislamiento-sin-jwt`).
- La línea base cubre lo existente: una consulta **nueva o modificada** (cambia su huella) que toque una tabla con
  `empresa_id` sin filtrarla hace fallar la prueba C hasta que se filtre o se revise y documente.

## Cambio posterior: acceso compartido entre empresas (migración 051)

- Tabla nueva `usuario_empresas` (con `empresa_id`): todas sus consultas filtran por empresa o por el usuario del contexto, salvo **una** que el escáner marcó y se revisó a mano: `SELECT … FROM usuarios WHERE id = $1` en `acceso.repository.js` (categoría `mantenimiento-o-global`: ámbito de plataforma, solo el maestro, y el servicio exige Owner/Admin activo). Sube a **486 literales / 142 consultas a revisar (153 ocurrencias)**.
- Las consultas que listan candidatos y accesos (`SELECT_COMPARTIBLES`, `SELECT_ACCESOS_DE`) mencionan `empresa_id` solo en un `JOIN`; el escáner las cuenta como «filtradas» por su criterio (límite conocido: comprueba presencia, no corrección). Son de ámbito de plataforma (`requirePlatformAdmin`); se cubren con `acceso-multiempresa.test.js` y `audit:tenant`.
- `audit:tenant` ahora entiende el acceso compartido (ver `docs/AUTH_STRATEGY.md` §5 bis): un autor con acceso (vigente o retirado) es válido; las dos claves del acceso cruzan empresas por diseño y se vigila que ningún acceso apunte a la empresa base.
