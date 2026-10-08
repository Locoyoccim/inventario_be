/**
 * «Alcance» de una empresa en la base: qué filas de qué tablas le pertenecen. Se descubre del esquema real (information_schema +
 * claves foráneas), no de una lista escrita a mano, así que una tabla nueva queda cubierta sola:
 *   - tabla con `empresa_id`            → filas con ese empresa_id
 *   - `empresas`                        → la propia fila
 *   - tabla hija sin `empresa_id`       → filas cuya clave foránea apunta a una fila del alcance de la empresa (varios niveles)
 *   - `roles` y `schema_migrations`     → catálogos globales: fuera del alcance
 *
 * Sirve para dos cosas de las pruebas de aislamiento: la HUELLA de los datos de una empresa (antes/después de que otra empresa
 * intente tocarlos) y la LIMPIEZA de los fixtures.
 */

const GLOBALES = new Set(["roles", "schema_migrations"]);
const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

/** @returns {Promise<Array<{tabla: string, predicado: string}>>} el predicado usa $1 = int[] de empresas */
export async function descubrirAlcance(pool) {
    const cols = (
        await pool.query(
            `SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name IN
               (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
        )
    ).rows;
    const tablas = [...new Set(cols.map((c) => c.table_name))]
        .filter((t) => !GLOBALES.has(t))
        .sort();
    const conEmpresa = new Set(
        cols.filter((c) => c.column_name === "empresa_id").map((c) => c.table_name),
    );
    const fks = (
        await pool.query(
            `SELECT c.conrelid::regclass::text AS hija, c.confrelid::regclass::text AS padre, ah.attname AS col, ap.attname AS col_padre
             FROM pg_constraint c
             JOIN pg_attribute ah ON ah.attrelid = c.conrelid AND ah.attnum = c.conkey[1]
             JOIN pg_attribute ap ON ap.attrelid = c.confrelid AND ap.attnum = c.confkey[1]
             WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND array_length(c.conkey, 1) = 1`,
        )
    ).rows;

    const alcance = new Map(); // tabla -> predicado (SQL sin alias, sobre las columnas de la propia tabla)
    for (const t of tablas) {
        if (t === "empresas") alcance.set(t, "id = ANY($1::int[])");
        else if (conEmpresa.has(t)) alcance.set(t, "empresa_id = ANY($1::int[])");
    }
    // Hijas sin empresa_id: a punto fijo, hasta que ninguna tabla nueva quede resuelta.
    let avanzo = true;
    while (avanzo) {
        avanzo = false;
        for (const t of tablas) {
            if (alcance.has(t)) continue;
            const caminos = fks
                .filter((f) => f.hija === t && alcance.has(f.padre) && f.padre !== t)
                .map(
                    (f) =>
                        `${q(f.col)} IN (SELECT ${q(f.col_padre)} FROM ${q(f.padre)} WHERE ${alcance.get(f.padre)})`,
                );
            if (caminos.length) {
                alcance.set(t, caminos.map((c) => `(${c})`).join(" OR "));
                avanzo = true;
            }
        }
    }
    const sinAlcance = tablas.filter((t) => !alcance.has(t));
    if (sinAlcance.length) {
        throw new Error(
            `Tablas sin forma de ligarse a una empresa (ni empresa_id ni FK a una tabla de empresa): ${sinAlcance.join(", ")}. Decide si son globales (agrégalas a GLOBALES en test/helpers/alcance.js) o añade su vínculo.`,
        );
    }
    return [...alcance].map(([tabla, predicado]) => ({ tabla, predicado }));
}

/** Huella (conteo + md5 de las filas completas) de cada tabla, restringida a las empresas dadas. Comparable antes/después. */
export async function huellaEmpresas(pool, ids, alcance) {
    const lista = alcance ?? (await descubrirAlcance(pool));
    const out = {};
    for (const { tabla, predicado } of lista) {
        const r = await pool.query(
            `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${q(tabla)} x WHERE ${predicado}`,
            [ids],
        );
        out[tabla] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
}

/** Tablas cuya huella cambió entre dos fotos: `{tabla: [antes, despues]}`. Vacío = idénticas. */
export function diferencias(antes, despues) {
    const out = {};
    for (const t of new Set([...Object.keys(antes), ...Object.keys(despues)]))
        if (antes[t] !== despues[t]) out[t] = [antes[t], despues[t]];
    return out;
}

/**
 * Borra todo lo que pertenece a las empresas dadas (y las empresas). Las claves foráneas fijan el orden: se reintenta por pasadas
 * hasta que no quede nada o no haya progreso (entonces lanza con el último error, para no ocultar un fixture mal limpiado).
 */
export async function limpiarEmpresas(pool, ids, alcance) {
    const lista = alcance ?? (await descubrirAlcance(pool));
    let pendientes = lista.filter((l) => l.tabla !== "empresas");
    let ultimoError = null;
    for (let pasada = 0; pasada < 12 && pendientes.length; pasada++) {
        const siguientes = [];
        for (const l of pendientes) {
            try {
                await pool.query(`DELETE FROM ${q(l.tabla)} WHERE ${l.predicado}`, [ids]);
            } catch (e) {
                if (e.code !== "23503") throw e; // solo se reintenta lo que depende del orden (violación de FK)
                ultimoError = e;
                siguientes.push(l);
            }
        }
        if (
            siguientes.length === pendientes.length &&
            siguientes.every((s, i) => s === pendientes[i])
        )
            break;
        pendientes = siguientes;
    }
    if (pendientes.length)
        throw new Error(
            `No se pudo limpiar ${pendientes.map((p) => p.tabla).join(", ")}: ${ultimoError?.message}`,
        );
    await pool.query("DELETE FROM empresas WHERE id = ANY($1::int[])", [ids]);
}
