# Módulo Ventas — Importación diaria desde Toteat

Descuenta del inventario los insumos consumidos por los platillos vendidos,
tomando el reporte de "Productos vendidos" que se exporta del POS (Toteat).
No requiere la API de pago de Toteat: se trabaja sobre el CSV exportado del panel.

## Cómo funciona

1. `pos_map` traduce cada nombre del reporte a una acción:
   - `RECETA`  → se explota su `receta_detalle` y se descuenta cada insumo.
   - `INSUMO`  → se descuenta ese insumo directo (modificadores como leche/huevo, o embotellados).
   - `IGNORAR` → categorías o modificadores que no descuentan (ej. "Sin Tequila").
2. Se agrega el consumo por insumo (la leche de varias recetas + su modificador caen en una sola resta).
3. Todo el día se descuenta en **una sola transacción** como movimientos `VENTA`
   (`referencia_tipo='VENTA_DIARIA'`, `referencia_id = venta_diaria.id`).
4. `venta_diaria` con `UNIQUE(empresa_id, fecha)` evita descontar dos veces el mismo día.

**Política de stock:** se permite stock negativo y se reporta como alerta
(`negativos`). Un negativo es la señal de que la receta o el conteo físico están mal.

## Instalación

```bash
psql "$DATABASE_URL" -f db/ventas_pos_map.sql   # crea pos_map y venta_diaria
```

## Recetas SIN leche

Carga las recetas de café **sin** la leche. La leche (entera/deslactosada/almendra)
se descuenta por sus renglones modificadores del reporte. Así mides cuánta de cada
tipo gastas, en vez de asumir una sola.

## Endpoints

### Mapeo (`pos_map`)
| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/pos-map/:empresa_id` | Listar mapeos |
| POST | `/api/pos-map/:empresa_id` | Crear/actualizar un mapeo (upsert por nombre) |
| POST | `/api/pos-map/:empresa_id/bulk` | Carga masiva (array de mapeos) |
| PUT | `/api/pos-map/:empresa_id/:id` | Editar un mapeo |
| DELETE | `/api/pos-map/:empresa_id/:id` | Borrar un mapeo |

Carga inicial sugerida: revisa y completa `db/pos_map_seed.csv` (llena `receta_id`/`producto_id`),
conviértelo a JSON y mándalo a `/bulk`.

Ejemplo de un mapeo:
```json
{ "nombre_pos": "Latte", "tipo": "RECETA", "receta_id": 12, "factor": 1 }
```

### Importación diaria
`POST /api/ventas/:empresa_id/importar`

Con líneas ya estructuradas:
```json
{ "fecha": "2026-09-17", "lineas": [ { "nombre_pos": "Latte", "cantidad": 4 } ] }
```
O con el CSV crudo de Toteat:
```json
{ "fecha": "2026-09-17", "csv": "Productos,Ana,Total\nLatte,4.00,4.00\n..." }
```

Respuesta (reporte):
```json
{
  "message": "Importación procesada",
  "data": {
    "venta_diaria": { "id": 1, "fecha": "2026-09-17", "total_lineas": 40, "total_unidades": 115 },
    "descontado": [ { "producto": "Leche deslactosada", "cantidad": 20, "stock_nuevo": 5 } ],
    "negativos": [ ... ],                 // insumos que quedaron bajo cero (revisar receta/conteo)
    "sin_mapeo": [ ... ],                 // nombres del POS que faltan en pos_map
    "ignorados": [ ... ],
    "recetas_sin_escandallo": [ ... ],    // recetas mapeadas pero sin ingredientes cargados
    "errores": [ ... ]
  }
}
```

- `409` si el día ya fue importado (revierte primero).

### Consultar / revertir un día
| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/ventas/:empresa_id/:fecha` | Ver el día y sus movimientos |
| DELETE | `/api/ventas/:empresa_id/:fecha` | Revertir: registra DEVOLUCION por cada VENTA y libera la fecha |
