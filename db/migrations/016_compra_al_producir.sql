-- 016: marca "compra al producir" en insumos perecederos.
-- Un insumo con compra_al_producir = true se compra justo cuando se va a producir:
-- no dispara alertas por mínimo y su necesidad aparece en las sugerencias de producción.
ALTER TABLE productos
    ADD COLUMN compra_al_producir boolean NOT NULL DEFAULT false;
