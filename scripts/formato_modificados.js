#!/usr/bin/env node
// TRINQUETE de formato (Prettier): comprueba —o aplica— el formato SOLO en los archivos que cambiaron, nunca en todo el repositorio.
// La consistencia mejora poco a poco, sin un commit de miles de líneas solo de formato. No cambia la configuración global de Prettier.
//
//   npm run format:check            comprueba los archivos modificados (lo que corre el CI en cada pull request)
//   npm run format                  les aplica Prettier (solo a ellos)
//   FORMATO_BASE=<rama|sha> ...     base de comparación (por defecto origin/main, origin/master, main o master)
//
// «Modificados» = lo que cambió desde el punto de partida = el ancestro común con la base, o —si es más reciente— el commit
// anotado en `.prettier-ratchet`. Ese archivo marca CUÁNDO empieza a exigirse el formato: sin él, el primer pull request de una
// rama larga exigiría reformatear todo lo que esa rama tocó antes del trinquete. Si el commit anotado ya no existe (squash merge),
// se ignora y se usa el ancestro común.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Pura: elige desde dónde se miran los cambios. El commit del trinquete solo manda si está entre el ancestro común y HEAD. */
export function elegirDesde({
    ancestroComun,
    trinquete,
    trinqueteExiste,
    ancestroComunEsAnteriorAlTrinquete,
    trinqueteEsAncestroDeHead,
}) {
    if (
        trinquete &&
        trinqueteExiste &&
        ancestroComunEsAnteriorAlTrinquete &&
        trinqueteEsAncestroDeHead
    )
        return trinquete;
    return ancestroComun;
}

const git = (args, { crudo = false } = {}) => {
    const salida = execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return crudo ? salida : salida.trim();
};
const exito = (args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;
const lista = (salida) => salida.split("\0").filter(Boolean);

function fallar(mensaje) {
    console.error(`\nformato: ${mensaje}`);
    process.exit(2);
}

function main() {
    const args = process.argv.slice(2);
    const escribir = args.includes("--write");
    let raiz;
    try {
        raiz = git(["rev-parse", "--show-toplevel"]);
    } catch {
        return fallar("esto no es un repositorio git.");
    }
    process.chdir(raiz);

    const candidatas = [
        args.find((a) => !a.startsWith("--")),
        process.env.FORMATO_BASE,
        "origin/main",
        "origin/master",
        "main",
        "master",
    ].filter(Boolean);
    const base = candidatas.find((c) =>
        exito(["rev-parse", "--verify", "--quiet", `${c}^{commit}`]),
    );
    if (!base)
        return fallar(
            "no encontré la rama base (origin/main, main...). Indica una con FORMATO_BASE=<rama o sha>.",
        );
    const ancestroComun = git(["merge-base", base, "HEAD"]);

    let trinquete = "";
    if (existsSync(".prettier-ratchet")) {
        trinquete =
            readFileSync(".prettier-ratchet", "utf8")
                .split("\n")
                .map((l) => l.trim())
                .find((l) => l && !l.startsWith("#")) ?? "";
    }
    const trinqueteExiste =
        Boolean(trinquete) && exito(["cat-file", "-e", `${trinquete}^{commit}`]);
    const desde = elegirDesde({
        ancestroComun,
        trinquete,
        trinqueteExiste,
        ancestroComunEsAnteriorAlTrinquete:
            trinqueteExiste && exito(["merge-base", "--is-ancestor", ancestroComun, trinquete]),
        trinqueteEsAncestroDeHead:
            trinqueteExiste && exito(["merge-base", "--is-ancestor", trinquete, "HEAD"]),
    });

    // Cambios ya commiteados desde ese punto + árbol de trabajo (staged o no) + archivos nuevos sin seguimiento. Sin borrados.
    const cambiados = new Set([
        ...lista(git(["diff", "--name-only", "-z", "--diff-filter=ACMR", desde], { crudo: true })),
        ...lista(git(["ls-files", "--others", "--exclude-standard", "-z"], { crudo: true })),
    ]);
    const archivos = [...cambiados].filter((f) => existsSync(f)).sort();
    const donde = `desde ${desde.slice(0, 7)}${desde === ancestroComun ? "" : " (inicio del trinquete)"}`;
    if (archivos.length === 0) {
        console.log(`formato: ningún archivo modificado ${donde}; nada que comprobar.`);
        return;
    }

    // Prettier del propio proyecto (versión fijada en package.json). Se busca junto al script y, si no, en la raíz del repositorio.
    // La configuración y el .prettierignore los toma Prettier de cada archivo, como siempre.
    let bin;
    for (const origen of [import.meta.url, `${pathToFileURL(raiz).href}/package.json`]) {
        try {
            bin = createRequire(origen).resolve("prettier/bin/prettier.cjs");
            break;
        } catch {
            /* se prueba el siguiente */
        }
    }
    if (!bin) return fallar("prettier no está instalado (npm ci).");
    const modo = escribir ? "--write" : "--list-different";
    const r = spawnSync(
        process.execPath,
        [bin, modo, "--ignore-unknown", "--no-error-on-unmatched-pattern", ...archivos],
        { encoding: "utf8" },
    );
    if (r.error) return fallar(`no se pudo ejecutar prettier: ${r.error.message}`);

    if (escribir) {
        process.stdout.write(r.stdout);
        if (r.status !== 0) return fallar(`prettier terminó con error:\n${r.stderr}`);
        console.log(
            `formato: aplicado a los ${archivos.length} archivo(s) modificados ${donde} (el resto no se tocó).`,
        );
        return;
    }
    if (r.status === 0) {
        console.log(
            `formato: los ${archivos.length} archivo(s) modificados ${donde} están formateados.`,
        );
        return;
    }
    if (r.status === 1) {
        const mal = r.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        console.error(
            `\nformato: ${mal.length} archivo(s) modificados ${donde} no cumplen Prettier:`,
        );
        for (const f of mal) console.error(`  ✖ ${f}`);
        console.error(
            "\nArréglalos SOLO a ellos (no formatees el resto del repositorio):  npm run format",
        );
        process.exit(1);
    }
    fallar(`prettier terminó con error:\n${r.stderr}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
