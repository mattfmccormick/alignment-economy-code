# Multi-stage Docker build for the AE platform-server.
#
# Stage 1 builds the TypeScript with full devDeps. Stage 2 copies only
# the compiled JS + production deps. The final image is small (~200MB
# including the Node base + native argon2). SQLite ships with Node 25
# so there's no native add-on to rebuild at runtime.
#
# The image runs `node dist/index.js` as a non-root user. The SQLite
# database lives at /data/platform.db, which the container mounts as a
# volume so the data survives container restarts.

# ── Stage 1: build ────────────────────────────────────────────────────
FROM node:25-bookworm-slim AS build

WORKDIR /app

# Install ONLY package files first so docker layer caching reuses the
# npm install layer when the source changes but deps don't.
COPY package.json package-lock.json ./

# argon2 builds against libargon2 + libc headers, so we need build-essential
# during the install. The runtime image drops these.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDeps so we only ship what runtime needs. argon2's native build
# output stays under node_modules/argon2/lib/binding/.
RUN npm prune --production

# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:25-bookworm-slim AS runtime

WORKDIR /app

# argon2 needs libargon2 at runtime even though the build artifacts are
# already compiled. The slim image doesn't include it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libargon2-1 \
 && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. Created after dependency install so the data
# directory ownership is set correctly when the volume mounts.
RUN useradd --create-home --uid 10001 --user-group ae \
 && mkdir -p /data \
 && chown -R ae:ae /data /app

USER ae

COPY --from=build --chown=ae:ae /app/node_modules ./node_modules
COPY --from=build --chown=ae:ae /app/dist ./dist
COPY --chown=ae:ae package.json ./

# Environment defaults. Real secrets MUST be set via the host or
# deployment platform (Fly.io secrets, Render env vars, etc).
ENV NODE_ENV=production \
    AE_PLATFORM_PORT=3500 \
    AE_PLATFORM_DB_PATH=/data/platform.db \
    AE_PLATFORM_EMAIL_MODE=dev

EXPOSE 3500
VOLUME ["/data"]

# Use `node` directly, not `npm start`, so signals (SIGTERM) propagate
# correctly. Without this, container shutdown stalls waiting for npm.
CMD ["node", "dist/index.js"]
