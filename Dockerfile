# syntax=docker/dockerfile:1

FROM node:22-slim

ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Self-contained yt-dlp build (no Python needed inside the container).
RUN set -eux; \
  case "${TARGETARCH}" in \
    arm64) YTDLP_BIN="yt-dlp_linux_aarch64" ;; \
    arm) YTDLP_BIN="yt-dlp_linux_armv7l" ;; \
    *) YTDLP_BIN="yt-dlp_linux" ;; \
  esac; \
  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_BIN}" -o /usr/local/bin/yt-dlp; \
  chmod +x /usr/local/bin/yt-dlp; \
  yt-dlp --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /app/data/cache

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
