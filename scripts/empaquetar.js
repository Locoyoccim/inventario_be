// Genera el paquete del código fuente desde un COMMIT (git archive), nunca desde la carpeta de trabajo.
//   npm run empaquetar            → dist/<proyecto>-<commit>.zip
//
// Por qué: empaquetar la carpeta con un ZIP manual se llevó el .env local. `git archive` solo incluye lo versionado.
// Protecciones (todas abortan con código 1 y NO imprimen valores de secretos):
//   1. El árbol debe estar limpio: el paquete tiene que ser exactamente un commit. Este script NUNCA hace commits.
//   2. Ningún valor del .env local (JWT_SECRET, PIN_PEPPER, SETUP_TOKEN, DB_PASSWORD, DATABASE_URL) puede aparecer en el commit.
//   3. El ZIP resultante se revisa: nada de .env, claves, volcados, respaldos ni node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";

const SECRETOS_DEL_ENV = ["JWT_SECRET", "PIN_PEPPER", "SETUP_TOKEN", "DB_PASSWORD", "DATABASE_URL"];
const LARGO_MINIMO_PATRON = 8; // valores más cortos darían falsos positivos con cualquier texto

const PROHIBIDOS = [
    [/(^|\/)\.env(\..+)?$/, "archivo .env (solo se permiten las plantillas .example/.sample/.template, p. ej. .env.example y .env.test.example)", /(^|\/)\.env(\.[a-z]+)*\.(example|sample|template)$/],
    [/\.(pem|key|p12|pfx|jks|keystore)$/i, "clave o certificado"],
    [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "clave SSH privada"],
    [/\.(dump|bak|sqlite3?|db)$/i, "volcado, respaldo o base de datos"],
    [/\.sql$/i, "archivo .sql fuera de db/migrations/", /^db\/migrations\/[^/]+\.sql$/],
    [/(^|\/)(backups|node_modules|\.git)\//, "carpeta de respaldos, dependencias o metadatos de git"],
    [/\.(zip|tgz|tar\.gz)$/i, "archivo comprimido dentro del paquete"],
];

/** Rutas (relativas al proyecto) que no deben viajar en un paquete. Devuelve [{ ruta, motivo }]. */
export function rutasProhibidas(rutas) {
    const out = [];
    for (const ruta of rutas) {
        for (const [patron, motivo, permitido] of PROHIBIDOS) {
            if (patron.test(ruta) && !(permitido && permitido.test(ruta))) {
                out.push({ ruta, motivo });
                break;
            }
        }
    }
    return out;
}

/** Nombres de las entradas de un ZIP, leyendo su directorio central (sin descomprimir ni depender de `unzip`). */
export function listarZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("ZIP inválido: no se encontró el directorio central");
    const total = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const nombres = [];
    for (let n = 0; n < total; n++) {
        if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("ZIP inválido: entrada corrupta");
        const largoNombre = buf.readUInt16LE(pos + 28);
        const largoExtra = buf.readUInt16LE(pos + 30);
        const largoComentario = buf.readUInt16LE(pos + 32);
        nombres.push(buf.toString("utf8", pos + 46, pos + 46 + largoNombre));
        pos += 46 + largoNombre + largoExtra + largoComentario;
    }
    return nombres;
}

const git = (args, raiz, opciones = {}) => execFileSync("git", args, { cwd: raiz, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opciones });

function fallar(mensaje) {
    console.error(`\nEmpaquetado abortado: ${mensaje}`);
    process.exit(1);
}

function main() {
    let raiz;
    try {
        raiz = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
    } catch {
        return fallar("esto no es un repositorio git (git archive necesita uno).");
    }
    const proyecto = basename(raiz);

    // 1) Árbol limpio. (Los archivos ignorados, como .env, no cuentan: justamente por eso no entran en el paquete.)
    const sucio = git(["status", "--porcelain"], raiz).trimEnd();
    if (sucio) {
        console.error(sucio.split("\n").slice(0, 15).join("\n"));
        return fallar("hay cambios sin commitear. El paquete debe ser exactamente un commit: haz commit (a mano) y vuelve a correr el script.");
    }
    let sha;
    try {
        sha = git(["rev-parse", "--short", "HEAD"], raiz).trim();
    } catch {
        return fallar("el repositorio no tiene ningún commit.");
    }

    // 2) El .env local no puede estar copiado dentro de lo versionado.
    const envLocal = join(raiz, ".env");
    if (existsSync(envLocal)) {
        const valores = dotenv.parse(readFileSync(envLocal));
        const patrones = SECRETOS_DEL_ENV.map((k) => valores[k]).filter((v) => v && v.length >= LARGO_MINIMO_PATRON && !v.includes("\n"));
        if (patrones.length) {
            try {
                // Los patrones viajan por stdin (no por argumentos): no quedan visibles en la lista de procesos.
                const coincidencias = git(["grep", "-lF", "-f", "-", "HEAD"], raiz, { input: patrones.join("\n") + "\n" });
                console.error(coincidencias.trim());
                return fallar("un valor del .env local aparece en archivos versionados (arriba). Quítalo del commit y rota ese secreto.");
            } catch (e) {
                if (e.status !== 1) return fallar(`no se pudo revisar el commit contra el .env: ${e.stderr || e.message}`);
                // status 1 = ninguna coincidencia: lo esperado
            }
        }
    }

    // 3) Generar y revisar el ZIP. dist/ debe estar ignorado, o el siguiente paquete vería el árbol sucio.
    const dist = join(raiz, "dist");
    try {
        git(["check-ignore", "-q", "dist/x"], raiz);
    } catch {
        return fallar("dist/ no está en .gitignore; agrégalo para que los paquetes no ensucien el árbol.");
    }
    mkdirSync(dist, { recursive: true });
    const salida = join(dist, `${proyecto}-${sha}.zip`);
    git(["archive", "--format=zip", `--prefix=${proyecto}/`, "-o", salida, "HEAD"], raiz);

    const entradas = listarZip(readFileSync(salida)).filter((n) => !n.endsWith("/")).map((n) => n.slice(proyecto.length + 1));
    const versionados = new Set(git(["ls-tree", "-r", "--name-only", "HEAD"], raiz).split("\n").filter(Boolean));
    const ajenos = entradas.filter((n) => !versionados.has(n));
    const prohibidas = rutasProhibidas(entradas);
    if (ajenos.length || prohibidas.length) {
        for (const a of ajenos) console.error(`  NO VERSIONADO  ${a}`);
        for (const p of prohibidas) console.error(`  PROHIBIDO      ${p.ruta}  (${p.motivo})`);
        return fallar(`el paquete no es seguro (${salida} NO debe entregarse).`);
    }
    console.log(`Paquete listo: ${salida}\n  commit ${sha} · ${entradas.length} archivos · sin .env, claves, volcados ni respaldos.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
