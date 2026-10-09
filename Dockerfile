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

# rclone se instala fijo y verificado, no el de Debian (1.60): con Cloudflare R2 esa versión daba 501 NotImplemented en la primera subida
# y «directory not found» al limpiar copias viejas. Los hashes salen de https://downloads.rclone.org/v1.75.2/SHA256SUMS.
ARG TARGETARCH=amd64
ARG RCLONE_VERSION=v1.75.2
ARG RCLONE_SHA256_AMD64=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
ARG RCLONE_SHA256_ARM64=7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && case "$TARGETARCH" in arm64) SHA="$RCLONE_SHA256_ARM64" ;; *) SHA="$RCLONE_SHA256_AMD64"; TARGETARCH=amd64 ;; esac \
 && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${TARGETARCH}.zip" \
 && echo "${SHA}  /tmp/rclone.zip" | sha256sum -c - \
 && unzip -j -q /tmp/rclone.zip "*/rclone" -d /usr/local/bin \
 && chmod 0755 /usr/local/bin/rclone \
 && rclone version | head -1 \
 && rm -f /tmp/rclone.zip \
 && apt-get purge -y --auto-remove curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Sin privilegios de root. Los respaldos temporales se escriben en /tmp (BACKUP_DIR), no en el código.
USER node
ENV BACKUP_DIR=/tmp/respaldos

CMD ["node", "server.js"]
