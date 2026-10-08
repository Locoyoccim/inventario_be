# Formato del código: trinquete de Prettier

Decisión: **no** se reformatea el repositorio. Prettier se exige únicamente a los archivos que un cambio modifica, así la consistencia mejora poco a poco sin commits de miles de líneas solo de formato, sin ensuciar `git blame` y sin cambiar la configuración global (`printWidth` incluido).

## Cómo funciona

- `npm run format:check` comprueba **solo los archivos modificados** (commits de la rama, cambios sin commitear y archivos nuevos). Es lo que corre el CI en cada pull request (job `formato`).
- `npm run format` aplica Prettier **solo a esos archivos**. El resto del repositorio no se toca.
- «Modificado» es lo cambiado desde el ancestro común con la rama base **o**, si es más reciente, desde el commit anotado en `.prettier-ratchet`. Ese archivo marca cuándo empieza a exigirse el formato; sin él, el primer PR de una rama larga exigiría reformatear todo lo que esa rama tocó antes del trinquete.
- Si el commit anotado deja de existir (por ejemplo, tras un _squash merge_), se ignora y se compara contra la rama base.
- Respeta `.prettierignore` y la configuración `.prettierrc.json`. Los YAML usan 2 espacios (convención de GitHub Actions); es la única excepción y no afecta al código.
- Base de comparación: `FORMATO_BASE=<rama|sha>` (por defecto `origin/main`, `origin/master`, `main` o `master`).

## Qué NO hacer

- No ejecutes `prettier --write .` ni `prettier --check .`: reformatearía ~180 archivos (≈ 15 000 líneas). Usa los scripts de arriba.
- Un archivo viejo sin formato que **modificas** queda reformateado entero en tu PR: es el costo del trinquete. Hazlo en un commit aparte si quieres que el diff funcional se lea limpio.

Pruebas: `test/formato-modificados.test.js` (repositorios git temporales).
