/**
 * Casos de la prueba dinámica de aislamiento (prueba B). Cada caso es UNA petición válida:
 *   - CONTROL: la empresa dueña la hace con sus propios ids → debe funcionar (2xx). Demuestra que el cuerpo es válido y que la
 *     ruta hace algo, así que un rechazo posterior no es un simple error de validación.
 *   - ATAQUE: la empresa B hace la misma petición con ids de la empresa A → debe fallar (4xx), sin cambiar NI revelar datos de A.
 *
 * tipo:
 *   recurso → el id de la RUTA es de A (B pide en su propia URL un recurso de A).
 *   fk      → la ruta es de B, pero un id del CUERPO/QUERY es de A (referencia cruzada).
 *   mixto   → ruta de B con un sub-recurso (renglón, etc.) de A bajo un recurso propio de B.
 *
 * `aj` fabrica los recursos que usa el ATACADO (de la empresa dueña del id: A en el ataque, la propia en el control);
 * `prin` los de quien PIDE (B en el ataque, A en el control). `params`/`body`/`query` reciben { aj, prin, E, D }:
 * E = empresa que pide, D = empresa dueña de `aj`.
 */
let n = 0;
const u = () =>
    `${Date.now().toString(36)}${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}${(n++).toString(36)}`;
const MOTIVO = { motivo: "prueba de aislamiento" };
const FECHA = (dias) => new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);

const caso = (c) => ({
    tipo: "recurso",
    aj: {},
    prin: {},
    params: () => ({}),
    body: () => undefined,
    query: () => "",
    quien: "tokAdmin",
    ...c,
});

const cuentaEnviadaAj = { aj: { c: "cuentaEnviada" } };
const cuentaConItemsAj = { aj: { c: "cuentaConItems" } };
const pagosExactos = [{ metodo: "EFECTIVO", monto: 110, recibido: 110 }];

export const CASOS = [
    // ───────── Usuarios y equipos ─────────
    caso({
        ruta: "PUT /api/usuarios/:empresa_id/:id",
        aj: { x: "usuario" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: "Renombrado", codigo_ingreso: `ren-${u()}` }),
    }),
    caso({
        ruta: "PUT /api/usuarios/:empresa_id/:id/pin",
        aj: { x: "usuario" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ pin: "4821" }),
    }),
    caso({
        ruta: "DELETE /api/usuarios/:empresa_id/:id/pin",
        aj: { x: "usuario" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/usuarios/:empresa_id/:id/pin/desbloquear",
        aj: { x: "usuario" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "PUT /api/dispositivos/:empresa_id/:id",
        aj: { x: "dispositivo" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: "Equipo renombrado" }),
    }),
    caso({
        ruta: "POST /api/dispositivos/:empresa_id/:id/codigo",
        aj: { x: "dispositivo" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/dispositivos/:empresa_id/:id/revocar",
        aj: { x: "dispositivo" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    // ───────── Catálogo: productos, proveedores, recetas, categorías ─────────
    caso({
        ruta: "GET /api/productos/:empresa_id/:id",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "PUT /api/productos/:empresa_id/:id",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ E }) => ({
            producto: `Editado ${u()}`,
            unidad_medida: "pz",
            proveedor_id: E.proveedorBase.id,
            categoria: E.catInsumo,
            cantidad_presentacion: 1,
            costo_presentacion: 12,
            stock_minimo: 1,
        }),
    }),
    caso({
        ruta: "PATCH /api/productos/:empresa_id/:id/limites",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ stock_minimo: 2 }),
    }),
    caso({
        ruta: "DELETE /api/productos/:empresa_id/:id",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "GET /api/productos/:empresa_id/:id/uso",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "GET /api/productos/:empresa_id/:id/movimientos",
        aj: { x: "productoConMovimiento" },
        params: ({ aj }) => ({ id: aj.x.id }),
        // Hallazgo documentado: esta ruta no responde 404 sino 200 con la lista VACÍA (el kardex se filtra por empresa). No revela ni
        // cambia nada; el control exige que la dueña SÍ vea filas para probar que lo vacío viene del filtro y no de la falta de datos.
        vacio: (json) =>
            Array.isArray(json?.data) && json.data.length === 0 && json.pagination?.total === 0,
    }),
    caso({
        ruta: "POST /api/productos/:empresa_id/:id/movimientos",
        aj: { x: "producto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ tipo_movimiento: "MERMA", cantidad: 1, motivo: "prueba" }),
    }),

    caso({
        ruta: "PUT /api/proveedores/:empresa_id/:id",
        aj: { x: "proveedor" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Prov editado ${u()}` }),
    }),
    caso({
        ruta: "GET /api/proveedores/:empresa_id/:id/resumen",
        aj: { x: "proveedor" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/proveedores/:empresa_id/:id/fusionar",
        aj: { x: "proveedor" },
        prin: { destino: "proveedor" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ prin }) => ({ destino_id: prin.destino.id }),
    }),
    caso({
        ruta: "DELETE /api/proveedores/:empresa_id/:id",
        aj: { x: "proveedor" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    caso({
        ruta: "GET /api/recetas/:empresa_id/:id",
        aj: { x: "receta" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "PUT /api/recetas/:empresa_id/:id",
        aj: { x: "receta" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ E }) => ({
            nombre: `Receta editada ${u()}`,
            categoria: E.catReceta,
            precio_venta: 60,
            ingredientes: [{ producto_id: E.productoBase.id, cantidad: 1 }],
        }),
    }),
    caso({
        ruta: "DELETE /api/recetas/:empresa_id/:id",
        aj: { x: "receta" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    caso({
        ruta: "PUT /api/categorias/:empresa_id/:id",
        aj: { x: "categoria" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Cat editada ${u()}` }),
    }),
    caso({
        ruta: "DELETE /api/categorias/:empresa_id/:id",
        aj: { x: "categoria" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    // ───────── Producción, conteos, compras ─────────
    caso({
        ruta: "GET /api/produccion/:empresa_id/plan/:receta_id",
        aj: { x: "preparacion" },
        params: ({ aj }) => ({ receta_id: aj.x.id }),
    }),
    caso({
        ruta: "GET /api/produccion/:empresa_id/:id",
        aj: { x: "produccion" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/produccion/:empresa_id/:id/anular",
        aj: { x: "produccion" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "GET /api/conteos/:empresa_id/:id",
        aj: { x: "conteo" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/conteos/:empresa_id/:id/anular",
        aj: { x: "conteo" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "GET /api/compras/:empresa_id/:id",
        aj: { x: "compra" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/compras/:empresa_id/:id/recibir",
        aj: { x: "pedido" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/compras/:empresa_id/:id/anular",
        aj: { x: "compra" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => MOTIVO,
    }),

    // ───────── Finanzas y reservaciones ─────────
    caso({
        ruta: "PUT /api/finanzas/:empresa_id/categorias-gasto/:id",
        aj: { x: "categoriaGasto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Cat gasto ${u()}` }),
    }),
    caso({
        ruta: "PUT /api/finanzas/:empresa_id/gastos/:id",
        aj: { x: "gasto" },
        prin: { cat: "categoriaGasto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ prin }) => ({
            fecha: FECHA(-1),
            categoria_id: prin.cat.id,
            concepto: "Gasto editado",
            monto: 20,
            metodo_pago: "EFECTIVO",
        }),
    }),
    caso({
        ruta: "POST /api/finanzas/:empresa_id/gastos/:id/anular",
        aj: { x: "gasto" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "PUT /api/finanzas/:empresa_id/ingresos/:id",
        aj: { x: "ingreso" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({
            fecha: FECHA(-1),
            metodo_pago: "TARJETA",
            monto: 25,
            concepto: "Ingreso editado",
        }),
    }),
    caso({
        ruta: "POST /api/finanzas/:empresa_id/ingresos/:id/anular",
        aj: { x: "ingreso" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "PUT /api/reservaciones/:empresa_id/:id",
        aj: { x: "reservacion" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({
            nombre_cliente: "Cliente editado",
            telefono_cliente: "5551112222",
            fecha: FECHA(6),
            hora: "21:00",
            personas: 3,
        }),
    }),
    caso({
        ruta: "PUT /api/reservaciones/:empresa_id/:id/estado",
        aj: { x: "reservacion" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ estado: "confirmada" }),
    }),
    caso({
        ruta: "DELETE /api/reservaciones/:empresa_id/:id",
        aj: { x: "reservacion" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    // ───────── POS: configuración ─────────
    caso({
        ruta: "PUT /api/pos/:empresa_id/areas/:id",
        aj: { x: "area" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Area ed ${u()}` }),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/mesas/:id",
        aj: { x: "mesa" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Mesa ed ${u()}` }),
    }),
    caso({
        ruta: "DELETE /api/pos/:empresa_id/mesas/:id",
        aj: { x: "mesa" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/asignacion-areas/categoria/:id",
        aj: { x: "categoria" },
        prin: { area: "area" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ prin }) => ({ area_id: prin.area.id }),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/asignacion-areas/:tipo/:id",
        aj: { x: "receta" },
        prin: { area: "area" },
        params: ({ aj }) => ({ tipo: "RECETA", id: aj.x.id }),
        body: ({ prin }) => ({ area_id: prin.area.id }),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/opciones/:id",
        aj: { x: "opcion" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: ({ E }) => ({
            nombre: `Grupo ed ${u()}`,
            modificadores: [{ nombre: "Extra ed", precio_extra: 3 }],
            articulos: [{ tipo: "RECETA", id: E.recetaBase.id }],
        }),
    }),
    caso({
        ruta: "DELETE /api/pos/:empresa_id/opciones/:id",
        aj: { x: "opcion" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),

    // ───────── POS: cuentas ─────────
    caso({
        ruta: "GET /api/pos/:empresa_id/cuentas/:id",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/descartar",
        aj: { c: "cuenta" },
        params: ({ aj }) => ({ id: aj.c.id }),
    }),
    caso({
        ruta: "PATCH /api/pos/:empresa_id/cuentas/:id",
        aj: { c: "cuenta" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({ personas: 3 }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/items",
        aj: { c: "cuenta" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: ({ E }) => ({ lineas: [{ tipo: "RECETA", id: E.recetaBase.id, cantidad: 1 }] }),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/cuentas/:id/items/:itemId",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id, itemId: aj.c.item_id }),
        body: () => ({ cantidad: 1 }),
    }),
    caso({
        ruta: "DELETE /api/pos/:empresa_id/cuentas/:id/items/:itemId",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id, itemId: aj.c.item_id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/items/:itemId/cancelar",
        ...cuentaEnviadaAj,
        params: ({ aj }) => ({ id: aj.c.id, itemId: aj.c.item_id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/items/:itemId/descuento",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id, itemId: aj.c.item_id }),
        body: () => ({ tipo: "PORCENTAJE", valor: 10, motivo: "prueba" }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/descuento",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({ tipo: "PORCENTAJE", valor: 10, motivo: "prueba" }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/corregir-pago",
        aj: { c: "cuentaPagada" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({ pagos: [{ metodo: "TARJETA", monto: 110 }], motivo: "prueba" }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/anular",
        aj: { c: "cuentaPagada" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => MOTIVO,
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/enviar",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/cambiar-mesa",
        aj: { c: "cuenta" },
        prin: { mesa: "mesa" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: ({ prin }) => ({ mesa_id: prin.mesa.id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/juntar",
        aj: { c: "cuenta" },
        prin: { destino: "cuenta" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: ({ prin }) => ({ destino_id: prin.destino.id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/dividir",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
        body: ({ aj }) => ({ partes: [{ item_id: aj.c.item_id, cantidad: 1 }] }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/precuenta",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/cobrar",
        ...cuentaEnviadaAj,
        prin: { turno: "turno" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({ pagos: pagosExactos }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/ticket",
        aj: { c: "cuentaPagada" },
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/cancelar",
        ...cuentaConItemsAj,
        params: ({ aj }) => ({ id: aj.c.id }),
        body: () => MOTIVO,
    }),

    // ───────── POS: cocina, caja, impresión ─────────
    caso({
        ruta: "POST /api/pos/:empresa_id/comandas/:id/estado",
        ...cuentaEnviadaAj,
        params: ({ aj }) => ({ id: aj.c.comanda_id }),
        body: () => ({ estado: "EN_PREPARACION" }),
    }),
    caso({
        ruta: "GET /api/pos/:empresa_id/turnos/:id/corte",
        aj: { t: "turnoLimpio" },
        params: ({ aj }) => ({ id: aj.t.id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/turnos/:id/cerrar",
        aj: { t: "turnoLimpio" },
        params: ({ aj }) => ({ id: aj.t.id }),
        body: () => ({ efectivo_contado: 100 }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/turnos/:id/corte/imprimir",
        aj: { t: "turnoLimpio" },
        params: ({ aj }) => ({ id: aj.t.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/impresiones/:id/descartar",
        ...cuentaEnviadaAj,
        params: ({ aj }) => ({ id: aj.c.impresion_id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/impresiones/:id/reimprimir",
        ...cuentaEnviadaAj,
        params: ({ aj }) => ({ id: aj.c.impresion_id }),
        body: () => ({}),
    }),
    caso({
        ruta: "GET /api/pos/:empresa_id/impresiones/:id",
        ...cuentaEnviadaAj,
        params: ({ aj }) => ({ id: aj.c.impresion_id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/impresiones/:id/impreso-navegador",
        aj: { c: "cuentaSinSalida" },
        params: ({ aj }) => ({ id: aj.c.impresion_id }),
        body: () => ({}),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/impresoras/:id",
        aj: { x: "impresora" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Impresora ed ${u()}` }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/impresoras/:id/prueba",
        aj: { x: "impresora" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "PUT /api/pos/:empresa_id/agentes/:id",
        aj: { x: "agente" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({ nombre: `Agente ed ${u()}` }),
    }),
    caso({
        ruta: "DELETE /api/pos/:empresa_id/agentes/:id",
        aj: { x: "agente" },
        params: ({ aj }) => ({ id: aj.x.id }),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/agentes/:id/rotar-token",
        aj: { x: "agente" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({}),
    }),
    caso({
        ruta: "POST /api/pos/:empresa_id/agentes/:id/codigo",
        aj: { x: "agente" },
        params: ({ aj }) => ({ id: aj.x.id }),
        body: () => ({}),
    }),

    // ═════════════ Referencias cruzadas: la ruta es de B pero un id del cuerpo / query / sub-recurso es de A ═════════════
    // En el CONTROL (`ctx.control`) todo sale de la misma empresa, así que la petición es válida y debe funcionar.

    // ───────── Catálogo ─────────
    caso({
        tipo: "fk",
        ruta: "POST /api/productos/:empresa_id",
        aj: { p: "proveedor" },
        body: ({ aj, E }) => ({
            producto: `FK prov ${u()}`,
            unidad_medida: "pz",
            proveedor_id: aj.p.id,
            categoria: E.catInsumo,
            cantidad_presentacion: 1,
            costo_presentacion: 10,
            stock_actual: 5,
            stock_minimo: 1,
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/productos/:empresa_id",
        aj: { c: "categoria" },
        body: ({ aj, E }) => ({
            producto: `FK cat ${u()}`,
            unidad_medida: "pz",
            proveedor_id: E.proveedorBase.id,
            categoria: aj.c.nombre,
            cantidad_presentacion: 1,
            costo_presentacion: 10,
            stock_actual: 5,
            stock_minimo: 1,
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "PUT /api/productos/:empresa_id/:id",
        prin: { x: "producto" },
        aj: { p: "proveedor" },
        params: ({ prin }) => ({ id: prin.x.id }),
        body: ({ aj, E }) => ({
            producto: `FK ed ${u()}`,
            unidad_medida: "pz",
            proveedor_id: aj.p.id,
            categoria: E.catInsumo,
            cantidad_presentacion: 1,
            costo_presentacion: 12,
            stock_minimo: 1,
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/recetas/:empresa_id",
        aj: { p: "producto" },
        body: ({ aj, E }) => ({
            nombre: `FK receta ${u()}`,
            categoria: E.catReceta,
            precio_venta: 10,
            ingredientes: [{ producto_id: aj.p.id, cantidad: 1 }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "PUT /api/recetas/:empresa_id/:id",
        prin: { r: "receta" },
        aj: { p: "producto" },
        params: ({ prin }) => ({ id: prin.r.id }),
        body: ({ aj, E }) => ({
            nombre: `FK receta ed ${u()}`,
            categoria: E.catReceta,
            precio_venta: 10,
            ingredientes: [{ producto_id: aj.p.id, cantidad: 1 }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/recetas/:empresa_id/preview",
        aj: { p: "producto" },
        body: ({ aj }) => ({
            precio_venta: 50,
            ingredientes: [{ producto_id: aj.p.id, cantidad: 1 }],
        }),
    }),
    caso({
        tipo: "mixto",
        ruta: "POST /api/proveedores/:empresa_id/:id/fusionar",
        prin: { x: "proveedor" },
        aj: { d: "proveedor" },
        params: ({ prin }) => ({ id: prin.x.id }),
        body: ({ aj }) => ({ destino_id: aj.d.id }),
    }),
    caso({
        tipo: "fk",
        ruta: "DELETE /api/categorias/:empresa_id/:id",
        prin: { x: "categoria" },
        aj: { d: "categoria" },
        params: ({ prin }) => ({ id: prin.x.id }),
        query: ({ aj }) => `?reasignar_a=${aj.d.id}`,
    }),

    // ───────── Compras, conteos, producción ─────────
    ...["POST /api/compras/:empresa_id", "POST /api/compras/:empresa_id/pedido"].flatMap((ruta) => [
        caso({
            tipo: "fk",
            ruta,
            aj: { p: "proveedor" },
            body: ({ aj, E }) => ({
                proveedor_id: aj.p.id,
                lineas: [{ producto_id: E.productoBase.id, cantidad: 1, costo_total: 10 }],
            }),
        }),
        caso({
            tipo: "fk",
            ruta,
            aj: { p: "producto" },
            body: ({ aj, E }) => ({
                proveedor_id: E.proveedorBase.id,
                lineas: [{ producto_id: aj.p.id, cantidad: 1, costo_total: 10 }],
            }),
        }),
    ]),
    caso({
        tipo: "fk",
        ruta: "POST /api/conteos/:empresa_id",
        aj: { p: "producto" },
        body: ({ aj }) => ({ lineas: [{ producto_id: aj.p.id, stock_fisico: 50 }] }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/produccion/:empresa_id/confirmar",
        aj: { r: "preparacion" },
        body: ({ aj }) => ({ producciones: [{ receta_id: aj.r.id, lotes: 1 }] }),
    }),

    // ───────── Finanzas ─────────
    caso({
        tipo: "fk",
        ruta: "POST /api/finanzas/:empresa_id/gastos",
        aj: { c: "categoriaGasto" },
        body: ({ aj }) => ({
            fecha: FECHA(-1),
            categoria_id: aj.c.id,
            concepto: "FK categoria",
            monto: 10,
            metodo_pago: "EFECTIVO",
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/finanzas/:empresa_id/gastos",
        prin: { c: "categoriaGasto" },
        aj: { p: "proveedor" },
        body: ({ aj, prin }) => ({
            fecha: FECHA(-1),
            categoria_id: prin.c.id,
            concepto: "FK proveedor",
            monto: 10,
            metodo_pago: "EFECTIVO",
            proveedor_id: aj.p.id,
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "PUT /api/finanzas/:empresa_id/gastos/:id",
        prin: { g: "gasto" },
        aj: { c: "categoriaGasto" },
        params: ({ prin }) => ({ id: prin.g.id }),
        body: ({ aj }) => ({
            fecha: FECHA(-1),
            categoria_id: aj.c.id,
            concepto: "FK categoria ed",
            monto: 10,
            metodo_pago: "EFECTIVO",
        }),
    }),

    // ───────── POS: apertura de cuentas, renglones y opciones ─────────
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas",
        aj: { m: "mesa" },
        body: ({ aj }) => ({ tipo: "MESA", mesa_id: aj.m.id }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas",
        aj: { r: "reservacion" },
        body: ({ aj }) => ({ tipo: "LLEVAR", reservacion_id: aj.r.id }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/items",
        prin: { c: "cuenta" },
        aj: { r: "receta" },
        params: ({ prin }) => ({ id: prin.c.id }),
        body: ({ aj }) => ({ lineas: [{ tipo: "RECETA", id: aj.r.id, cantidad: 1 }] }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/items",
        prin: { c: "cuenta" },
        aj: { o: "opcion" },
        params: ({ prin }) => ({ id: prin.c.id }),
        // La receta es de quien pide; la opción (modificador) es de la otra empresa.
        body: ({ aj, E }) => ({
            lineas: [
                {
                    tipo: "RECETA",
                    id: E.recetaBase.id,
                    cantidad: 1,
                    opciones: [aj.o.modificador_id],
                },
            ],
        }),
    }),
    // Renglón de A bajo una cuenta propia de B (sub-recurso cruzado). En el control, el renglón es de la MISMA cuenta.
    ...[
        [
            "PUT /api/pos/:empresa_id/cuentas/:id/items/:itemId",
            "cuentaConItems",
            () => ({ cantidad: 1 }),
        ],
        [
            "DELETE /api/pos/:empresa_id/cuentas/:id/items/:itemId",
            "cuentaConItems",
            () => undefined,
        ],
        [
            "POST /api/pos/:empresa_id/cuentas/:id/items/:itemId/cancelar",
            "cuentaEnviada",
            () => MOTIVO,
        ],
        [
            "POST /api/pos/:empresa_id/cuentas/:id/items/:itemId/descuento",
            "cuentaConItems",
            () => ({ tipo: "PORCENTAJE", valor: 10, motivo: "prueba" }),
        ],
    ].map(([ruta, tipoCuenta, body]) =>
        caso({
            tipo: "mixto",
            ruta,
            prin: { c: tipoCuenta },
            aj: { c: tipoCuenta },
            params: ({ aj, prin, control }) => ({
                id: prin.c.id,
                itemId: (control ? prin : aj).c.item_id,
            }),
            body,
        }),
    ),
    caso({
        tipo: "mixto",
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/dividir",
        prin: { c: "cuentaConItems" },
        aj: { c: "cuentaConItems" },
        params: ({ prin }) => ({ id: prin.c.id }),
        body: ({ aj, prin, control }) => ({
            partes: [{ item_id: (control ? prin : aj).c.item_id, cantidad: 1 }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/cambiar-mesa",
        prin: { c: "cuenta" },
        aj: { m: "mesa" },
        params: ({ prin }) => ({ id: prin.c.id }),
        body: ({ aj }) => ({ mesa_id: aj.m.id }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/cuentas/:id/juntar",
        prin: { c: "cuenta" },
        aj: { d: "cuenta" },
        params: ({ prin }) => ({ id: prin.c.id }),
        body: ({ aj }) => ({ destino_id: aj.d.id }),
    }),
    // Credenciales de un supervisor de OTRA empresa para autorizar una acción de un mesero (sin permiso propio de autorizar).
    ...[
        [
            "POST /api/pos/:empresa_id/cuentas/:id/descuento",
            "cuentaConItems",
            (a) => ({ tipo: "PORCENTAJE", valor: 10, motivo: "prueba", autorizacion: a }),
        ],
        [
            "POST /api/pos/:empresa_id/cuentas/:id/items/:itemId/cancelar",
            "cuentaEnviada",
            (a) => ({ ...MOTIVO, autorizacion: a }),
        ],
        [
            "POST /api/pos/:empresa_id/cuentas/:id/cancelar",
            "cuentaEnviada",
            (a) => ({ ...MOTIVO, autorizacion: a }),
        ],
    ].map(([ruta, tipoCuenta, body]) =>
        caso({
            tipo: "fk",
            quien: "tokMesero",
            ruta,
            prin: { c: tipoCuenta },
            params: ({ prin }) => ({ id: prin.c.id, itemId: prin.c.item_id }),
            // Ataque: B (mesero) presenta el correo y la contraseña del supervisor de A. Control: A (mesero) presenta los de SU supervisor.
            body: ({ D }) => body({ email: D.emailSupervisor, password: D.passwordSupervisor }),
        }),
    ),

    // ───────── POS: configuración con referencias cruzadas ─────────
    caso({
        tipo: "mixto",
        ruta: "PUT /api/pos/:empresa_id/asignacion-areas/categoria/:id",
        prin: { x: "categoria" },
        aj: { a: "area" },
        params: ({ prin }) => ({ id: prin.x.id }),
        body: ({ aj }) => ({ area_id: aj.a.id }),
    }),
    caso({
        tipo: "mixto",
        ruta: "PUT /api/pos/:empresa_id/asignacion-areas/:tipo/:id",
        prin: { x: "receta" },
        aj: { a: "area" },
        params: ({ prin }) => ({ tipo: "RECETA", id: prin.x.id }),
        body: ({ aj }) => ({ area_id: aj.a.id }),
    }),
    caso({
        tipo: "mixto",
        ruta: "PUT /api/pos/:empresa_id/asignacion-areas/:tipo/:id",
        prin: { x: "producto" },
        aj: { a: "area" },
        params: ({ prin }) => ({ tipo: "PRODUCTO", id: prin.x.id }),
        body: ({ aj }) => ({ area_id: aj.a.id }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/opciones",
        aj: { p: "producto" },
        body: ({ aj, E }) => ({
            nombre: `FK op ${u()}`,
            modificadores: [
                { nombre: "Con insumo", precio_extra: 2, producto_id: aj.p.id, cantidad: 1 },
            ],
            articulos: [{ tipo: "RECETA", id: E.recetaBase.id }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/opciones",
        aj: { r: "receta" },
        body: ({ aj }) => ({
            nombre: `FK op art ${u()}`,
            modificadores: [{ nombre: "Extra", precio_extra: 2 }],
            articulos: [{ tipo: "RECETA", id: aj.r.id }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "PUT /api/pos/:empresa_id/opciones/:id",
        prin: { g: "opcion" },
        aj: { r: "receta" },
        params: ({ prin }) => ({ id: prin.g.id }),
        body: ({ aj }) => ({
            nombre: `FK op ed ${u()}`,
            modificadores: [{ nombre: "Extra", precio_extra: 2 }],
            articulos: [{ tipo: "RECETA", id: aj.r.id }],
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "POST /api/pos/:empresa_id/impresoras",
        aj: { a: "area" },
        body: ({ aj }) => ({
            nombre: `FK imp ${u()}`,
            conexion: "RED",
            ip: "10.1.1.1",
            area_id: aj.a.id,
        }),
    }),
    caso({
        tipo: "fk",
        ruta: "PUT /api/pos/:empresa_id/impresoras/:id",
        prin: { x: "impresora" },
        aj: { a: "area" },
        params: ({ prin }) => ({ id: prin.x.id }),
        body: ({ aj }) => ({ area_id: aj.a.id }),
    }),

    // ───────── Filtros por query con ids de otra empresa (lista de la propia empresa → vacía, nunca con datos ajenos) ─────────
    caso({
        tipo: "fk",
        ruta: "GET /api/compras/:empresa_id",
        aj: { c: "compra" },
        prin: { c: "compra" },
        query: ({ aj }) => `?proveedor_id=${aj.c.proveedor_id}`,
        vacio: (json) => Array.isArray(json?.data) && json.data.length === 0,
    }),
    caso({
        tipo: "fk",
        ruta: "GET /api/finanzas/:empresa_id/gastos",
        aj: { g: "gasto" },
        prin: { g: "gasto" },
        query: ({ aj }) => `?categoria_id=${aj.g.categoria_id}`,
        vacio: (json) => Array.isArray(json?.data) && json.data.length === 0,
    }),
    caso({
        tipo: "fk",
        ruta: "GET /api/pos/:empresa_id/comandas/activas",
        aj: { c: "cuentaEnviada" },
        prin: { c: "cuentaEnviada" },
        query: ({ D }) => `?area_id=${D.areaConPantalla}`,
        vacio: (json) => Array.isArray(json?.data) && json.data.length === 0,
    }),
    caso({
        tipo: "fk",
        ruta: "GET /api/movimientos/:empresa_id",
        aj: { p: "productoConMovimiento" },
        prin: { p: "productoConMovimiento" },
        query: ({ aj }) => `?producto_id=${aj.p.id}`,
        vacio: (json) => Array.isArray(json?.data) && json.data.length === 0,
    }),
];
