# syntax=docker/dockerfile:1.7
# Estimates AI Agent — web (Next.js 15, standalone output). Listens on 3000 inside the container.

ARG NODE_IMAGE=node:22-alpine

# ---- deps: install exact lockfile deps (the musl build of @node-rs/argon2 is picked automatically)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: typecheck + next build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG BUILD_HASH=dev
ENV BUILD_HASH=${BUILD_HASH} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: only the standalone server + static assets, as a non-root user.
# No extra OS packages: run with `init: true` in compose (tini as PID 1) for signal forwarding.
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ARG BUILD_HASH=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    BUILD_HASH=${BUILD_HASH} \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data/files
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app \
 && mkdir -p /data/files && chown -R app:app /data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
