BEGIN;

-- El rol «mesero» se creó (027) como un lugar reservado "para cuando exista un POS". El POS ya existe y el rol
-- opera mesas y comandas: el nombre y las descripciones que ve cada empresa al asignar roles deben decirlo.
-- Solo se reescribe lo que sigue con el texto original (si alguien lo personalizó, no se toca).
UPDATE public.roles SET nombre = 'Mesero',
    descripcion = 'Toma órdenes en las mesas, envía las comandas a cocina y barra, y maneja reservaciones.'
WHERE clave = 'mesero' AND nombre = 'Mesero (próximamente)';

UPDATE public.roles SET descripcion = 'Recibe y acomoda reservaciones de piso; ve el mapa de mesas.'
WHERE clave = 'hostess' AND descripcion = 'Recibe y acomoda reservaciones de piso.';

UPDATE public.roles SET descripcion = 'Cobra en caja, abre y cierra su turno y puede tomar reservaciones telefónicas.'
WHERE clave = 'cajero' AND descripcion = 'Cobra en caja y puede tomar reservaciones telefónicas.';

UPDATE public.roles SET descripcion = 'Respaldo operativo de turno: autoriza descuentos, cancelaciones y anulaciones; compras, conteos, producción, finanzas y reservaciones.'
WHERE clave = 'supervisor' AND descripcion = 'Respaldo operativo de turno: compras, conteos, producción, finanzas y reservaciones.';

COMMIT;
