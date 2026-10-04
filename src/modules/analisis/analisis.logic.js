// Lógica pura del análisis del negocio (sin BD): ingeniería de menú, costo teórico contra real y control de fugas.
// Las consultas viven en analisis.repository.js; aquí solo se calcula y se clasifica, para poder probarlo sin base.

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v ?? 0);

// ---------------------------------------------------------------------------------------------------------------
// 1. Ingeniería de menú (método de Kasavana y Smith)
// ---------------------------------------------------------------------------------------------------------------
//
// Cada platillo o bebida se ubica según dos preguntas:
//   · ¿Se vende bien?   Popular si su parte de las unidades vendidas llega al 70 % de lo que le tocaría en un
//                       reparto parejo entre todos (70 / N por ciento).
//   · ¿Deja buen dinero? Margen alto si lo que deja por unidad (venta sin IVA − costo) es igual o mayor al
//                       promedio de lo que deja cada unidad vendida del menú.
//
//   estrella      popular + margen alto      → protegerlo: no tocar precio ni receta
//   popular       popular + margen bajo      → vende mucho pero deja poco: subir precio o bajar costo
//   oportunidad   no popular + margen alto   → deja buen dinero pero se pide poco: promoverlo
//   revisar       no popular + margen bajo   → reformular, reemplazar o sacarlo
//
// Un artículo sin costo conocido (receta sin ingredientes) no se clasifica: no se puede medir su margen.

export const CLASES_MENU = ["estrella", "popular", "oportunidad", "revisar"];

/**
 * @param filas  [{ tipo, id, nombre, categoria, unidades, ventas_netas, costo_unitario, precio_actual, iva_pct, precio_incluye_iva }]
 *               ventas_netas = lo vendido en el periodo sin IVA y ya con descuentos y cortesías aplicados.
 * @param opts   { foodCostObjetivo } objetivo de costo de alimentos (%) de la empresa.
 */
export function clasificarMenu(filas, { foodCostObjetivo = 30 } = {}) {
    const items = filas.map((f) => {
        const unidades = num(f.unidades);
        const costoUnit = num(f.costo_unitario);
        const ventas = num(f.ventas_netas);
        const costo = costoUnit * unidades;
        const sinCosto = !(costoUnit > 0);
        return {
            tipo: f.tipo, id: f.id, nombre: f.nombre, categoria: f.categoria ?? null,
            unidades, ventas_netas: r2(ventas), costo: r2(costo), margen: r2(ventas - costo),
            margen_unitario: unidades > 0 ? r2((ventas - costo) / unidades) : 0,
            food_cost_pct: ventas > 0 && !sinCosto ? r2((costo / ventas) * 100) : null,
            precio_actual: f.precio_actual === null || f.precio_actual === undefined ? null : r2(f.precio_actual),
            costo_unitario: r2(costoUnit),
            sin_costo: sinCosto,
            popularidad_pct: null, clase: null, precio_sugerido: null,
            _iva: num(f.iva_pct), _incluye: f.precio_incluye_iva !== false,
        };
    });

    const medibles = items.filter((i) => !i.sin_costo && i.unidades > 0);
    const unidadesTotal = medibles.reduce((s, i) => s + i.unidades, 0);
    const margenTotal = medibles.reduce((s, i) => s + i.margen, 0);
    const margenPromedio = unidadesTotal > 0 ? margenTotal / unidadesTotal : 0;
    const umbralPopularidad = medibles.length > 0 ? 70 / medibles.length : 0;

    for (const i of items) {
        if (i.sin_costo || i.unidades <= 0) continue;
        i.popularidad_pct = r2((i.unidades / unidadesTotal) * 100);
        const popular = i.popularidad_pct >= umbralPopularidad - 1e-9;
        const alto = i.margen_unitario >= margenPromedio - 1e-9;
        i.clase = popular ? (alto ? "estrella" : "popular") : alto ? "oportunidad" : "revisar";
        // Precio con el que el costo de alimentos llegaría al objetivo (solo si hoy se pasa del objetivo).
        const netoObjetivo = i.costo_unitario / (foodCostObjetivo / 100);
        const bruto = i._incluye ? netoObjetivo * (1 + i._iva / 100) : netoObjetivo;
        const sugerido = Math.ceil(bruto - 1e-9);
        if (i.precio_actual !== null && i.precio_actual > 0 && sugerido > i.precio_actual) i.precio_sugerido = sugerido;
    }

    const ventas = items.reduce((s, i) => s + i.ventas_netas, 0);
    const costo = medibles.reduce((s, i) => s + i.costo, 0);
    const ventasMedibles = medibles.reduce((s, i) => s + i.ventas_netas, 0);
    const conteoPorClase = Object.fromEntries(CLASES_MENU.map((c) => [c, items.filter((i) => i.clase === c).length]));

    return {
        items: items.map(({ _iva, _incluye, ...resto }) => resto).sort((a, b) => b.margen - a.margen),
        totales: {
            articulos: items.length,
            unidades: items.reduce((s, i) => s + i.unidades, 0),
            ventas_netas: r2(ventas),
            costo: r2(costo),
            margen: r2(ventasMedibles - costo),
            food_cost_pct: ventasMedibles > 0 ? r2((costo / ventasMedibles) * 100) : null,
            sin_costo: items.filter((i) => i.sin_costo).length,
        },
        referencias: { margen_unitario_promedio: r2(margenPromedio), popularidad_minima_pct: r2(umbralPopularidad) },
        por_clase: conteoPorClase,
        // Con menos de 4 artículos medibles los promedios no distinguen nada: la pantalla lo avisa.
        suficiente: medibles.length >= 4,
        objetivo_food_cost: foodCostObjetivo,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Costo teórico contra costo real por insumo
// ---------------------------------------------------------------------------------------------------------------
//
// Teórico = lo que las ventas debieron gastar según las recetas (movimientos VENTA, menos devoluciones por anulación).
// Pérdida = lo que salió de más: merma registrada + faltante que descubrió un conteo físico (un sobrante lo compensa).
// Un insumo que nunca se cuenta no puede mostrar faltantes: queda marcado «sin conteo» para no dar falsa tranquilidad.

export const UMBRAL_DESVIACION_ALTA = 10; // % de pérdida sobre el consumo teórico
export const UMBRAL_DESVIACION_MEDIA = 5;

export function nivelDesviacion(desviacionPct, perdidaValor) {
    if (!(perdidaValor > 0)) return "ok";
    if (desviacionPct === null) return "sin_ventas";
    if (desviacionPct >= UMBRAL_DESVIACION_ALTA) return "alto";
    if (desviacionPct >= UMBRAL_DESVIACION_MEDIA) return "medio";
    return "bajo";
}

/**
 * @param filas      por producto: { producto_id, producto, unidad_medida, venta_qty, venta_valor, devol_qty, devol_valor,
 *                   merma_qty, merma_valor, conteo_qty, conteo_valor, ajuste_qty, ajuste_valor }
 *                   conteo_* y ajuste_* son netos con signo (negativo = faltante / salió de más).
 * @param contados   Map producto_id → fecha del último conteo (cualquier fecha) y Set de los contados dentro del periodo.
 * @param serie      [{ periodo, teorico_valor, perdida_valor }] ya agrupada por semana (o la unidad pedida)
 */
export function armarConsumo(filas, { ultimoConteo = new Map(), contadosEnPeriodo = new Set(), ventasNetas = 0, serie = [] } = {}) {
    const items = filas.map((f) => {
        const teoricoQty = num(f.venta_qty) - num(f.devol_qty);
        const teoricoValor = num(f.venta_valor) - num(f.devol_valor);
        const diferenciaQty = num(f.conteo_qty);
        const diferenciaValor = num(f.conteo_valor);
        const perdidaQty = num(f.merma_qty) - diferenciaQty;
        const perdidaValor = num(f.merma_valor) - diferenciaValor;
        const desviacion = teoricoValor > 0 ? (perdidaValor / teoricoValor) * 100 : null;
        const id = Number(f.producto_id);
        return {
            producto_id: id, producto: f.producto, unidad_medida: f.unidad_medida,
            teorico_qty: r2(teoricoQty), teorico_valor: r2(teoricoValor),
            merma_qty: r2(num(f.merma_qty)), merma_valor: r2(num(f.merma_valor)),
            diferencia_conteo_qty: r2(diferenciaQty), diferencia_conteo_valor: r2(diferenciaValor),
            ajuste_manual_valor: r2(num(f.ajuste_valor)),
            perdida_qty: r2(perdidaQty), perdida_valor: r2(perdidaValor),
            desviacion_pct: desviacion === null ? null : r2(desviacion),
            nivel: nivelDesviacion(desviacion === null ? null : desviacion, perdidaValor),
            contado_en_periodo: contadosEnPeriodo.has(id),
            ultimo_conteo: ultimoConteo.get(id) ?? null,
        };
    });
    items.sort((a, b) => b.perdida_valor - a.perdida_valor || b.teorico_valor - a.teorico_valor);

    const suma = (campo) => r2(items.reduce((s, i) => s + i[campo], 0));
    const teorico = suma("teorico_valor");
    const perdida = suma("perdida_valor");
    const sinConteo = items.filter((i) => i.teorico_valor > 0 && !i.contado_en_periodo);
    return {
        items,
        totales: {
            teorico_valor: teorico,
            merma_valor: suma("merma_valor"),
            diferencia_conteo_valor: suma("diferencia_conteo_valor"),
            perdida_valor: perdida,
            real_valor: r2(teorico + perdida),
            desviacion_pct: teorico > 0 ? r2((perdida / teorico) * 100) : null,
            teorico_pct_ventas: ventasNetas > 0 ? r2((teorico / ventasNetas) * 100) : null,
            real_pct_ventas: ventasNetas > 0 ? r2(((teorico + perdida) / ventasNetas) * 100) : null,
            ventas_netas: r2(ventasNetas),
            alertas_altas: items.filter((i) => i.nivel === "alto").length,
            alertas_medias: items.filter((i) => i.nivel === "medio").length,
            // Consumo que ningún conteo del periodo respalda: ahí podría haber pérdidas sin descubrir.
            sin_conteo_insumos: sinConteo.length,
            sin_conteo_valor: r2(sinConteo.reduce((s, i) => s + i.teorico_valor, 0)),
        },
        serie: serie.map((s) => ({ periodo: s.periodo, teorico_valor: r2(s.teorico_valor), perdida_valor: r2(s.perdida_valor) })),
        umbrales: { alto: UMBRAL_DESVIACION_ALTA, medio: UMBRAL_DESVIACION_MEDIA },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Control de fugas (descuentos, cortesías, cancelaciones, anulaciones)
// ---------------------------------------------------------------------------------------------------------------
//
// Todo lo que pasó por autorización de un supervisor queda en pos_autorizaciones. Aquí se resume por tipo y por persona
// y se marca a quien concentra mucho más que el resto frente a lo que vende. Un indicador no es una acusación: sirve
// para saber a quién revisar primero.

// Los tipos que representan dinero que se dejó de cobrar o se devolvió. Corregir un pago o quitar un descuento no.
export const TIPOS_CON_MONTO = ["DESCUENTO", "CORTESIA", "CANCELAR_ITEM", "CANCELAR_CUENTA", "ANULAR_CUENTA"];
export const TIPOS_FUGA = [...TIPOS_CON_MONTO, "QUITAR_DESCUENTO", "CORREGIR_PAGO"];
const MIN_EVENTOS_ATIPICO = 3;
const FACTOR_ATIPICO = 2;

/**
 * @param eventos        [{ id, fecha, tipo, monto, motivo, folio, solicitado_por, solicitante, autorizado_por, autorizador }]
 * @param ventasPorUsuario Map usuario_id → ventas (con IVA) de las cuentas cobradas donde fue mesero o cobró
 * @param ventasTotal    ventas (con IVA) cobradas en el periodo
 */
export function armarFugas(eventos, { ventasPorUsuario = new Map(), ventasTotal = 0, mermaCancelaciones = 0 } = {}) {
    const porTipo = new Map(TIPOS_FUGA.map((t) => [t, { tipo: t, eventos: 0, monto: 0 }]));
    const porUsuario = new Map();
    const porAutorizador = new Map();

    for (const e of eventos) {
        const conMonto = TIPOS_CON_MONTO.includes(e.tipo);
        const monto = conMonto ? num(e.monto) : 0;
        const t = porTipo.get(e.tipo) ?? { tipo: e.tipo, eventos: 0, monto: 0 };
        t.eventos += 1;
        t.monto += monto;
        porTipo.set(e.tipo, t);

        // La persona es quien lo hizo; si el supervisor lo hizo directo, él mismo.
        const uid = e.solicitado_por ?? e.autorizado_por;
        const nombre = e.solicitado_por ? e.solicitante : e.autorizador;
        const u = porUsuario.get(uid) ?? { usuario_id: uid, nombre, eventos: 0, monto: 0, por_tipo: {} };
        u.eventos += 1;
        u.monto += monto;
        u.por_tipo[e.tipo] = (u.por_tipo[e.tipo] ?? 0) + 1;
        porUsuario.set(uid, u);

        const a = porAutorizador.get(e.autorizado_por) ?? { usuario_id: e.autorizado_por, nombre: e.autorizador, eventos: 0, monto: 0 };
        a.eventos += 1;
        a.monto += monto;
        porAutorizador.set(e.autorizado_por, a);
    }

    const monto = [...porTipo.values()].reduce((s, t) => s + t.monto, 0);
    const pctGlobal = ventasTotal > 0 ? (monto / ventasTotal) * 100 : null;

    const usuarios = [...porUsuario.values()].map((u) => {
        const ventas = num(ventasPorUsuario.get(u.usuario_id));
        const pct = ventas > 0 ? (u.monto / ventas) * 100 : null;
        const atipico = pct !== null && pctGlobal !== null && pctGlobal > 0 && u.eventos >= MIN_EVENTOS_ATIPICO && pct >= pctGlobal * FACTOR_ATIPICO;
        return { ...u, monto: r2(u.monto), ventas: r2(ventas), pct_ventas: pct === null ? null : r2(pct), atipico };
    }).sort((a, b) => b.monto - a.monto || b.eventos - a.eventos);

    return {
        totales: {
            eventos: eventos.length,
            monto: r2(monto),
            ventas: r2(ventasTotal),
            pct_ventas: pctGlobal === null ? null : r2(pctGlobal),
            merma_cancelaciones: r2(mermaCancelaciones),
            atipicos: usuarios.filter((u) => u.atipico).length,
        },
        por_tipo: [...porTipo.values()].map((t) => ({ ...t, monto: r2(t.monto) })),
        por_usuario: usuarios,
        por_autorizador: [...porAutorizador.values()].map((a) => ({ ...a, monto: r2(a.monto) })).sort((a, b) => b.eventos - a.eventos),
        recientes: eventos.slice(0, 30).map((e) => ({
            id: e.id, fecha: e.fecha, tipo: e.tipo, monto: TIPOS_CON_MONTO.includes(e.tipo) ? r2(e.monto) : null, motivo: e.motivo ?? null,
            folio: e.folio ?? null, usuario: e.solicitante ?? e.autorizador, autorizado_por: e.autorizador,
        })),
        factor_atipico: FACTOR_ATIPICO,
        min_eventos_atipico: MIN_EVENTOS_ATIPICO,
    };
}
