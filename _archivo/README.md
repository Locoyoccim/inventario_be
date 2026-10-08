# Archivo (no se usa)

Scripts de una sola vez de la etapa inicial. Se conservan por historia, **no forman parte del sistema** y no los ejecuta
ningún comando de `npm`.

| Archivo | Qué era | Aviso |
| --- | --- | --- |
| `reset_e_insumos_empresa4.sql` | Reiniciaba y recargaba los insumos de la empresa 4 | **Destructivo**: borra inventario real. No lo corras. |
| `ventas_pos_map.sql` | Carga inicial del mapeo de productos de Toteat | Obsoleto: el POS propio reemplazó a Toteat. |
| `pos_map_seed.csv` | Datos para ese mapeo | Obsoleto. |
| `cargar_receta.py` | Carga manual de una receta | Usa la pantalla de Recetas. |

Si ya no los necesitas, bórralos con confianza (los respaldos de la base están en `docs/RESPALDOS.md`).
