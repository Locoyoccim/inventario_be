-- El costo del movimiento se guardaba con 2 decimales: insumos por g/ml ($0.025/g) quedaban
-- en $0.03 (+20%) y los reportes de valor salian inflados. Mismo scale que productos.costo_unitario.
-- Los movimientos ya registrados conservan el valor redondeado.
ALTER TABLE movimientosinventario
    ALTER COLUMN costo_unitario TYPE numeric(10,4);
