# Imagen única del backend para Railway: la API (`node server.js`) y los crons de respaldo y purga (`npm run backup`, `npm run purgar:ips`)
# usan esta misma imagen y solo cambian el comando de inicio (docs/DESPLIEGUE.md).
#
# Por qué un Dockerfile y no el builder automático: `npm run backup` necesita pg_dump/pg_restore de la MISMA versión mayor que el servidor
# (o más nueva), y la plantilla de PostgreSQL de Railway es la 18, que no está en los repositorios de Debian. Se instala desde el
# repositorio oficial de PostgreSQL (PGDG). rclone sube el respaldo a Cloudflare R2 (BACKUP_UPLOAD_CMD).
# Imagen base desde el espejo oficial de AWS ECR Public, no desde Docker Hub: los constructores de Railway comparten IP y Docker Hub
# les responde 429 (Too Many Requests) de vez en cuando, lo que tumbó tres despliegues el 2026-10-09 (no era un fallo del código).
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl postgresql-common rclone \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Sin privilegios de root. Los respaldos temporales se escriben en /tmp (BACKUP_DIR), no en el código.
USER node
ENV BACKUP_DIR=/tmp/respaldos

CMD ["node", "server.js"]
