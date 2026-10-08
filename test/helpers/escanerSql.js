/**
 * Escáner estático del SQL del backend, para la prueba de regresión de aislamiento (prueba C).
 *
 * Extrae los literales SQL de `src/` (cadenas y plantillas que empiezan por SELECT/INSERT/UPDATE/DELETE/WITH) y, con el esquema real
 * de la base, decide por cada uno si toca alguna tabla con `empresa_id` y si la FILTRA. Es una HEURÍSTICA, con límites conocidos:
 *   · ve literales, no SQL armado en tiempo de ejecución (`where.push(...)`, concatenaciones);
 *   · comprueba que `empresa_id` figure como filtro o como columna insertada, no que el filtro sea el correcto.
 * Por eso es una red contra omisiones nuevas, no una prueba de corrección: la corrección la demuestra la prueba dinámica (A/B).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const LITERAL = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const ES_SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

function archivosJs(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) out.push(...archivosJs(ruta));
        else if (e.name.endsWith(".js")) out.push(ruta);
    }
    return out.sort();
}

/** Normaliza para la huella: sin `${...}`, espacios colapsados, sin mayúsculas/minúsculas. */
export const normalizar = (sql) =>
    sql
        .replace(/\$\{[^}]*\}/g, "?")
        .replace(/\s+/g, " ")
        .trim();
export const huellaDe = (sql) =>
    createHash("sha1").update(normalizar(sql).toLowerCase()).digest("hex").slice(0, 12);

/** Nombre del método/función que contiene la posición `i` del texto (el último `nombre(` o `async nombre(` antes de ella). */
function contenedor(src, i) {
    const antes = src.slice(0, i);
    const re =
        /^\s*(?:static\s+)?(?:async\s+)?(?:#)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|^\s*([A-Za-z_$][\w$]*)\s*=\s*(?:asyncHandler\()?(?:async\s*)?\(/gm;
    let ultimo = null;
    let m;
    while ((m = re.exec(antes))) {
        const nombre = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!["if", "for", "while", "switch", "catch", "function", "return"].includes(nombre))
            ultimo = nombre;
    }
    return ultimo;
}

/**
 * Constantes de texto del archivo (`const NOMBRE = \`...\`` o con comillas), para resolver `${NOMBRE}` dentro de otras consultas.
 * Solo identificadores simples; cualquier otra expresión interpolada queda como `?`.
 */
function constantesDeTexto(src) {
    const mapa = new Map();
    for (const m of src.matchAll(
        /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*;/g,
    ))
        mapa.set(m[1], m[2].slice(1, -1));
    return mapa;
}
function resolver(sql, constantes, profundidad = 0) {
    if (profundidad > 4) return sql;
    return sql.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (todo, nombre) =>
        constantes.has(nombre)
            ? resolver(constantes.get(nombre), constantes, profundidad + 1)
            : todo,
    );
}

/** Todas las consultas SQL literales de `raiz` (por defecto src/). `archivo` va con `/` y relativo al directorio de trabajo. */
export function extraerConsultas(raiz = "src") {
    const out = [];
    for (const f of archivosJs(raiz)) {
        const src = readFileSync(f, "utf8");
        const constantes = constantesDeTexto(src);
        for (const m of src.matchAll(LITERAL)) {
            const crudo = m[1].slice(1, -1);
            if (!ES_SQL.test(crudo) || crudo.length < 20) continue;
            const sql = resolver(crudo, constantes);
            out.push({
                archivo: relative(process.cwd(), f).split(sep).join("/"),
                linea: src.slice(0, m.index).split("\n").length,
                metodo: contenedor(src, m.index),
                sql: normalizar(sql),
                huella: huellaDe(sql),
            });
        }
    }
    return out;
}

// «Filtra por empresa»: empresa_id como columna comparada (=, IN, ANY) en cualquier lado, o en la lista de columnas de un INSERT.
const FILTRA = [
    /\bempresa_id\s*(=|IN\b|<>|!=)/i,
    /(=|\bIN\b|ANY\s*\()\s*\(?\s*[\w.$]*\bempresa_id\b/i,
];
export function filtraPorEmpresa(sql) {
    if (FILTRA.some((re) => re.test(sql))) return true;
    const ins = /^\s*INSERT\s+INTO\s+\w+\s*\(([^)]*)\)/i.exec(sql);
    return Boolean(ins && /\bempresa_id\b/i.test(ins[1]));
}

/**
 * Tablas del esquema que toca la consulta y su relación con la empresa.
 * @param {string} sql
 * @param {{conEmpresa: Set<string>, todas: Set<string>}} esquema
 */
export function analizar(sql, esquema) {
    const tablas = new Set();
    for (const t of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/gi)) {
        const nombre = t[1].toLowerCase();
        if (esquema.todas.has(nombre)) tablas.add(nombre);
    }
    const tenant = [...tablas].filter((t) => esquema.conEmpresa.has(t));
    const hijas = [...tablas].filter(
        (t) =>
            !esquema.conEmpresa.has(t) && !["roles", "empresas", "schema_migrations"].includes(t),
    );
    return {
        tablas: [...tablas].sort(),
        tenant: tenant.sort(),
        hijas: hijas.sort(),
        menciona: /\bempresa_id\b/i.test(sql),
        filtra: filtraPorEmpresa(sql),
    };
}

/** Lee del esquema vivo qué tablas existen y cuáles tienen `empresa_id`. */
export async function leerEsquema(pool) {
    const r = await pool.query(
        `SELECT c.table_name, bool_or(c.column_name = 'empresa_id') AS tiene
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         GROUP BY c.table_name`,
    );
    return {
        todas: new Set(r.rows.map((x) => x.table_name)),
        conEmpresa: new Set(r.rows.filter((x) => x.tiene).map((x) => x.table_name)),
    };
}

/**
 * Consultas que tocan una tabla con empresa_id SIN filtrarla (y las que tocan solo tablas hijas): son las que exigen revisión.
 * Se agrupan por huella (archivo + SQL normalizado) con su número de ocurrencias.
 */
export function pendientesDeRevision(consultas, esquema) {
    const grupos = new Map();
    for (const c of consultas) {
        const a = analizar(c.sql, esquema);
        const sinFiltro = a.tenant.length > 0 && !a.filtra;
        const soloHijas = a.tenant.length === 0 && a.hijas.length > 0;
        if (!sinFiltro && !soloHijas) continue;
        const clave = `${c.archivo}#${c.huella}`;
        const g = grupos.get(clave) ?? {
            archivo: c.archivo,
            huella: c.huella,
            ocurrencias: 0,
            lineas: [],
            metodo: c.metodo,
            sql: c.sql,
            tipo: sinFiltro ? "tabla-con-empresa-sin-filtro" : "solo-tablas-hijas",
            ...a,
        };
        g.ocurrencias++;
        g.lineas.push(c.linea);
        grupos.set(clave, g);
    }
    return [...grupos.values()];
}
