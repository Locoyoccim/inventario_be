#!/usr/bin/env node
// Auditoría de CONTAMINACIÓN ENTRE EMPRESAS, de solo lectura:  npm run audit:tenant [-- --empresas=1,2] [--json]
//
// Busca filas que apunten a una fila de OTRA empresa. No corrige nada, nunca: informa y sale con código 1 si encuentra algo.
// Corre dentro de una transacción READ ONLY que siempre termina en ROLLBACK, con el mismo rol de la app (basta SELECT).
//
// Qué revisa (todo descubierto del esquema real, así una tabla o una FK nueva queda cubierta sola):
//   1. Cada clave foránea simple hija → padre: la empresa de la fila hija debe ser la de la fila padre. La empresa de una tabla
//      sin `empresa_id` se deriva por su cadena de claves foráneas (p. ej. el kardex, por su producto: así un movimiento cuyo
//      usuario es de otra empresa también se detecta, porque la FK al usuario se compara contra la empresa del producto).
//   2. Columnas *_id que no tienen FK en la base (item de una autorización, usuario de una llave de idempotencia...).
//   3. Referencias polimórficas (kardex.referencia_id según referencia_tipo; impresiones.referencia_id según tipo).
//   4. Categorías por nombre: producto o receta cuya categoría solo existe en OTRA empresa.
//   5. Accesos compartidos (usuario_empresas): ninguno puede apuntar a la empresa base de la persona. Y una persona con (o que tuvo) un
//      acceso a una empresa es un autor VÁLIDO de filas de esa empresa: el punto 1 no lo cuenta como contaminación. Un acceso retirado
//      se desactiva, no se borra, justamente para que lo que esa persona dejó siga teniendo un autor válido.
//
// Códigos de salida: 0 limpio · 1 contaminación encontrada · 2 error al auditar.
import { pathToFileURL } from "node:url";

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

// Columnas *_id sin FK en la base. Si se agrega una nueva sin FK, la prueba test/audit-tenant.test.js lo avisa.
export const SIN_FK = [
    { hija: "pos_autorizaciones", col: "item_id", padre: "pos_cuenta_items", colPadre: "id" },
    { hija: "pos_idempotencia", col: "usuario_id", padre: "usuarios", colPadre: "id" },
    { hija: "produccion", col: "usuario_id", padre: "usuarios", colPadre: "id" },
];

// Referencias polimórficas: `col` apunta a `padre` solo cuando `tipoCol` vale alguno de `tipos`.
export const POLIMORFICAS = [
    {
        hija: "movimientosinventario",
        col: "referencia_id",
        tipoCol: "referencia_tipo",
        tipos: ["COMPRA", "COMPRA_ANULADA"],
        padre: "compra",
        colPadre: "id",
    },
    {
        hija: "movimientosinventario",
        col: "referencia_id",
        tipoCol: "referencia_tipo",
        tipos: ["CONTEO", "CONTEO_ANULADO"],
        padre: "conteo_fisico",
        colPadre: "id",
    },
    {
        hija: "movimientosinventario",
        col: "referencia_id",
        tipoCol: "referencia_tipo",
        tipos: ["PRODUCCION", "PRODUCCION_ANULADA"],
        padre: "produccion",
        colPadre: "id",
    },
    {
        hija: "movimientosinventario",
        col: "referencia_id",
        tipoCol: "referencia_tipo",
        tipos: ["POS_CUENTA", "POS_MERMA"],
        padre: "pos_cuentas",
        colPadre: "id",
    },
    {
        hija: "movimientosinventario",
        col: "referencia_id",
        tipoCol: "referencia_tipo",
        tipos: ["VENTA_DIARIA"],
        padre: "venta_diaria",
        colPadre: "id",
    },
    {
        hija: "pos_impresiones",
        col: "referencia_id",
        tipoCol: "tipo",
        tipos: ["COMANDA"],
        padre: "pos_comandas",
        colPadre: "id",
    },
    {
        hija: "pos_impresiones",
        col: "referencia_id",
        tipoCol: "tipo",
        tipos: ["PRECUENTA", "TICKET"],
        padre: "pos_cuentas",
        colPadre: "id",
    },
    {
        hija: "pos_impresiones",
        col: "referencia_id",
        tipoCol: "tipo",
        tipos: ["CORTE"],
        padre: "pos_turnos",
        colPadre: "id",
    },
    {
        hija: "pos_impresiones",
        col: "referencia_id",
        tipoCol: "tipo",
        tipos: ["PRUEBA"],
        padre: "impresoras",
        colPadre: "id",
    },
];

/** Lee del esquema las tablas, cuáles tienen empresa_id y las claves foráneas simples. */
export async function descubrir(db) {
    const cols = (
        await db.query(
            `SELECT c.table_name, c.column_name FROM information_schema.columns c
             JOIN information_schema.tables t USING (table_schema, table_name)
             WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
        )
    ).rows;
    const fks = (
        await db.query(
            `SELECT c.conrelid::regclass::text AS hija, ah.attname AS col, c.confrelid::regclass::text AS padre, ap.attname AS "colPadre"
             FROM pg_constraint c
             JOIN pg_attribute ah ON ah.attrelid = c.conrelid AND ah.attnum = c.conkey[1]
             JOIN pg_attribute ap ON ap.attrelid = c.confrelid AND ap.attnum = c.confkey[1]
             WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND array_length(c.conkey, 1) = 1
             ORDER BY 1, 2`,
        )
    ).rows;
    return {
        tablas: new Set(cols.map((c) => c.table_name)),
        conEmpresa: new Set(
            cols.filter((c) => c.column_name === "empresa_id").map((c) => c.table_name),
        ),
        conId: new Set(cols.filter((c) => c.column_name === "id").map((c) => c.table_name)),
        fks,
    };
}

/** Expresión SQL de la empresa de una fila de `tabla` con alias `alias`; null si la tabla es global o no se puede derivar. */
export function empresaDe(tabla, alias, esq, profundidad = 0) {
    if (tabla === "empresas") return `${alias}.${q("id")}`;
    if (esq.conEmpresa.has(tabla)) return `${alias}.${q("empresa_id")}`;
    if (profundidad > 3) return null;
    const caminos = esq.fks
        .filter((f) => f.hija === tabla && f.padre !== tabla)
        .sort((a, b) => (a.padre + a.col).localeCompare(b.padre + b.col));
    for (const f of caminos) {
        const a = `${alias}_${profundidad}`;
        const interna = empresaDe(f.padre, a, esq, profundidad + 1);
        if (interna)
            return `(SELECT ${interna} FROM ${q(f.padre)} ${a} WHERE ${a}.${q(f.colPadre)} = ${alias}.${q(f.col)})`;
    }
    return null;
}

/** SQL (solo SELECT) de una relación hija → padre. `filtro` restringe a ciertas empresas ($1 = int[]). */
export function sqlRelacion({ hija, col, padre, colPadre, cuando = "" }, esq, conFiltro) {
    const eH = empresaDe(hija, "c", esq);
    const eP = empresaDe(padre, "p", esq);
    if (!eH || !eP) return null;
    // Autor de otra empresa base pero con acceso compartido (vigente o retirado) a la empresa de la fila: es válido.
    const autorConAcceso =
        padre === "usuarios" && esq.tablas.has("usuario_empresas")
            ? `AND NOT EXISTS (SELECT 1 FROM usuario_empresas ue WHERE ue.usuario_id = p.${q(colPadre)} AND ue.empresa_id = ${eH})`
            : "";
    const ejemplo = esq.conId.has(hija) ? `to_jsonb(c)->>'id'` : `c.${q(col)}::text`;
    return `SELECT count(*)::int AS n, (array_agg(${ejemplo}))[1:5] AS ejemplos
            FROM ${q(hija)} c JOIN ${q(padre)} p ON p.${q(colPadre)} = c.${q(col)}
            WHERE c.${q(col)} IS NOT NULL ${cuando} AND ${eH} IS NOT NULL AND ${eP} IS NOT NULL AND ${eH} <> ${eP}
              ${autorConAcceso}
              ${conFiltro ? `AND (${eH} = ANY($1::int[]) OR ${eP} = ANY($1::int[]))` : ""}`;
}

// Un acceso compartido es, por definición, una persona de una empresa en OTRA: sus dos claves (la persona y quién lo otorgó, del lado del
// maestro) cruzan empresas por diseño. Se omiten de la comparación genérica y se vigilan con su propia regla (accesoABase).
const CRUZAN_POR_DISENO = new Set(["usuario_empresas.usuario_id", "usuario_empresas.otorgado_por"]);

const sqlAccesoABase = (conFiltro) => `
    SELECT count(*)::int AS n, (array_agg(ue.usuario_id::text || ':' || ue.empresa_id::text))[1:5] AS ejemplos
    FROM usuario_empresas ue JOIN usuarios u ON u.id = ue.usuario_id
    WHERE u.empresa_id = ue.empresa_id
      ${conFiltro ? "AND ue.empresa_id = ANY($1::int[])" : ""}`;

/** Categorías por nombre que solo existen en OTRA empresa (28 exige que existan en la propia). */
const sqlCategorias = (tabla, conFiltro) => `
    SELECT count(*)::int AS n, (array_agg(c.id::text))[1:5] AS ejemplos FROM ${q(tabla)} c
    WHERE btrim(c.categoria) <> ''
      AND NOT EXISTS (SELECT 1 FROM categorias k WHERE k.empresa_id = c.empresa_id AND lower(btrim(k.nombre)) = lower(btrim(c.categoria)))
      AND EXISTS (SELECT 1 FROM categorias k WHERE k.empresa_id <> c.empresa_id AND lower(btrim(k.nombre)) = lower(btrim(c.categoria)))
      ${conFiltro ? "AND c.empresa_id = ANY($1::int[])" : ""}`;

/**
 * Ejecuta la auditoría con un cliente `db` (con .query). Solo emite SELECT. Devuelve { revisadas, hallazgos, omitidas }.
 * @param {{query: Function}} db
 * @param {{empresas?: number[]|null}} [opciones]  limita a filas que involucren a esas empresas
 */
export async function auditar(db, { empresas = null } = {}) {
    const esq = await descubrir(db);
    const conFiltro = Array.isArray(empresas) && empresas.length > 0;
    const params = conFiltro ? [empresas] : [];
    const relaciones = [
        ...esq.fks.map((f) => ({ ...f, tipo: "fk" })),
        ...SIN_FK.map((r) => ({ ...r, tipo: "sin-fk" })),
        ...POLIMORFICAS.map((r) => ({
            ...r,
            tipo: "polimorfica",
            cuando: `AND c.${q(r.tipoCol)} = ANY(ARRAY[${r.tipos.map((t) => `'${t}'`).join(",")}]::text[])`,
        })),
    ];
    const hallazgos = [];
    const omitidas = [];
    let revisadas = 0;
    for (const r of relaciones) {
        const nombre = `${r.hija}.${r.col} → ${r.padre}.${r.colPadre}${r.tipos ? ` [${r.tipoCol} = ${r.tipos.join("|")}]` : ""}`;
        if (CRUZAN_POR_DISENO.has(`${r.hija}.${r.col}`)) {
            omitidas.push(`${nombre} (acceso compartido: cruza empresas por diseño)`);
            continue;
        }
        const sql = sqlRelacion(r, esq, conFiltro);
        if (!sql) {
            omitidas.push(nombre); // un lado es un catálogo global (p. ej. roles): no hay empresa que comparar
            continue;
        }
        revisadas++;
        const { n, ejemplos } = (await db.query(sql, params)).rows[0];
        if (n > 0) hallazgos.push({ tipo: r.tipo, relacion: nombre, filas: n, ejemplos });
    }
    if (esq.tablas.has("usuario_empresas")) {
        revisadas++;
        const { n, ejemplos } = (await db.query(sqlAccesoABase(conFiltro), params)).rows[0];
        if (n > 0)
            hallazgos.push({
                tipo: "acceso-a-empresa-base",
                relacion:
                    "usuario_empresas (usuario, empresa) → la empresa es la base de la persona",
                filas: n,
                ejemplos,
            });
    }
    for (const tabla of ["productos", "recetas"]) {
        revisadas++;
        const { n, ejemplos } = (await db.query(sqlCategorias(tabla, conFiltro), params)).rows[0];
        if (n > 0)
            hallazgos.push({
                tipo: "categoria-por-nombre",
                relacion: `${tabla}.categoria → categorias.nombre (de otra empresa)`,
                filas: n,
                ejemplos,
            });
    }
    return { revisadas, hallazgos, omitidas };
}

/** Corre `auditar` en una transacción READ ONLY (consistente) que siempre termina en ROLLBACK. */
export async function auditarSoloLectura(pool, opciones) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
        return await auditar(client, opciones);
    } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
    }
}

function leerArgumentos(argv) {
    const empresas = argv.find((a) => a.startsWith("--empresas="));
    return {
        json: argv.includes("--json"),
        empresas: empresas
            ? empresas
                  .slice("--empresas=".length)
                  .split(",")
                  .map((x) => Number(x))
                  .filter(Number.isInteger)
            : null,
    };
}

async function main() {
    const { json, empresas } = leerArgumentos(process.argv.slice(2));
    const { default: pool } = await import("../src/config/db.js");
    try {
        const r = await auditarSoloLectura(pool, { empresas });
        if (json) console.log(JSON.stringify(r, null, 2));
        else {
            console.log(
                `audit:tenant — ${r.revisadas} relaciones revisadas${empresas ? ` (solo empresas ${empresas.join(", ")})` : ""}, ${r.omitidas.length} omitidas (catálogos globales). Solo lectura: no se corrigió nada.`,
            );
            if (r.hallazgos.length === 0) console.log("✔ Sin contaminación entre empresas.");
            else {
                console.log(
                    `✖ ${r.hallazgos.length} relación(es) con filas que apuntan a OTRA empresa:`,
                );
                for (const h of r.hallazgos)
                    console.log(
                        `  · ${h.relacion}: ${h.filas} fila(s), ids de ejemplo: ${(h.ejemplos ?? []).join(", ")}`,
                    );
                console.log(
                    "\nNo se modificó nada. Investiga el origen antes de corregir (los datos pueden ser el único rastro de un fallo de aislamiento).",
                );
            }
        }
        process.exitCode = r.hallazgos.length > 0 ? 1 : 0;
    } catch (e) {
        console.error(`audit:tenant falló: ${e.message}`);
        process.exitCode = 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
