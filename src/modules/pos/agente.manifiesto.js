// Manifiesto de versiones del agente de impresión: lo que el agente consulta para actualizarse solo y lo que la pantalla de
// Agentes usa para avisar «desactualizado» y ofrecer el instalador. Sale de variables de entorno (no hay nada que guardar).
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export const comparar = (a, b) => {
    const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
    return 0;
};

/** null si no hay versión publicada. Un manifiesto a medias (sin hash, URL no https) no se publica: el agente no descargaría algo sin verificar. */
export function leerManifiesto(env = process.env) {
    const version = env.AGENTE_ULTIMA_VERSION?.trim();
    if (!version || !SEMVER.test(version)) return null;
    const url = env.AGENTE_URL_DESCARGA?.trim();
    const sha256 = env.AGENTE_SHA256?.trim().toLowerCase();
    const minima = env.AGENTE_VERSION_MINIMA?.trim();
    const instalador = env.AGENTE_INSTALADOR_URL?.trim();
    const descargable = Boolean(url && /^https:\/\/\S+$/.test(url) && sha256 && SHA256.test(sha256));
    return {
        version,
        minima: minima && SEMVER.test(minima) ? minima : null,
        url: descargable ? url : null,
        sha256: descargable ? sha256 : null,
        instalador: instalador && /^https:\/\/\S+$/.test(instalador) ? instalador : null,
    };
}

export const estaDesactualizado = (versionAgente, manifiesto) => Boolean(manifiesto && versionAgente && SEMVER.test(versionAgente) && comparar(versionAgente, manifiesto.version) < 0);
