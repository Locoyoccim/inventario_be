BEGIN;

-- D6: índices para las consultas frecuentes sobre el log de movimientos (la tabla
-- que más crece). Aceleran: historial por producto, detalle por referencia
-- (compras/ventas/conteos/producción) y reportes por fecha.
CREATE INDEX IF NOT EXISTS movinv_producto_fecha_idx
  ON public.movimientosinventario(producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS movinv_referencia_idx
  ON public.movimientosinventario(referencia_tipo, referencia_id);
CREATE INDEX IF NOT EXISTS movinv_fecha_idx
  ON public.movimientosinventario(fecha);

COMMIT;
