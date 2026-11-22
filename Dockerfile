# One image for both the app (API + WebSockets + MCP + SPA) and the worker.
# The server runs TypeScript directly on Node's built-in type stripping; only the web app is built.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/companion/package.json apps/companion/
COPY apps/importer/package.json apps/importer/
RUN npm ci --no-audit --no-fund

FROM deps AS web
COPY packages/contract packages/contract
COPY apps/web apps/web
RUN npm run build -w @autologger/web

# Node plus the worker's system tools: ffmpeg + yt-dlp for YouTube import.
# Also the base of the dev worker in compose.dev.yaml, which mounts the source instead of copying it.
FROM node:24-slim AS tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
  && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*

FROM tools AS runtime
WORKDIR /app
ENV NODE_ENV=production WEB_DIST=/app/apps/web/dist PORT=8080
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.base.json ./
COPY packages/contract packages/contract
COPY apps/server apps/server
# The local import helper, served at /api/importer/autologger-import.mjs (docs/importer.md).
COPY apps/importer/autologger-import.mjs apps/importer/
COPY --from=web /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["node", "src/main.ts"]
