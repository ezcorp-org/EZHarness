# Stage 1: Build
FROM oven/bun:1 AS builder
WORKDIR /app

# Install root dependencies
COPY package.json bun.lock ./
# Workspace package.json files must be present before `bun install` can resolve
# `workspace:*` specifiers. Only the manifest is needed here — source lands later.
COPY packages/@ezcorp/sdk/package.json packages/@ezcorp/sdk/
COPY packages/@ezcorp/ai-kit/package.json packages/@ezcorp/ai-kit/
RUN bun install --frozen-lockfile

# Install web dependencies
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN cd web && bun run build

# Stage 2: Runtime
FROM oven/bun:1-slim
WORKDIR /app

# Phase 7 (MCP isolation) runtime dependencies. `oven/bun:1-slim` is
# debian-bookworm and ships without these; the namespace launcher
# (`src/extensions/mcp-launcher.sh`) needs all three:
#   - util-linux  →  `unshare`, `prlimit`, `capsh`
#   - iproute2    →  `ip` (bring up loopback inside the netns)
#   - iptables    →  `iptables-restore` (apply OUTPUT-DROP DROP-ALL
#                    inside the netns; defense-in-depth on top of the
#                    network namespace's own missing upstream interface)
#
# Image growth: ~20 MB. We need the runtime binaries in the final image
# (not just at build time) because each MCP spawn shells out to them.
#
# Kernel knob requirement (NOT installable via apt): the host kernel
# must allow unprivileged user namespace creation. Either set
# `kernel.unprivileged_userns_clone=1` (legacy) or run the container
# with `--cap-add=NET_ADMIN`. See `docs/deployment.md` for details.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       util-linux \
       iproute2 \
       iptables \
       libcap2-bin \
  && rm -rf /var/lib/apt/lists/*

# Build-time metadata injected by CI (`docker/metadata-action` → build-args).
# Surfaced as OCI labels for image introspection and as env vars the app
# reads at runtime (`EZCORP_IMAGE_SHA` is the circuit-breaker key; see
# src/db/connection.ts).
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
ENV EZCORP_IMAGE_VERSION=$VERSION
ENV EZCORP_IMAGE_SHA=$REVISION
LABEL org.opencontainers.image.title="ezcorp" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.created=$CREATED \
      org.opencontainers.image.source="https://github.com/ezcorp-org/EZcorp" \
      org.opencontainers.image.description="EZ Corp AI — self-hosted agent runtime with embedded PGlite"

# Install production dependencies (root)
COPY package.json bun.lock ./
# Workspace package.json required to resolve `workspace:*` specifiers.
COPY packages/@ezcorp/sdk/package.json packages/@ezcorp/sdk/
COPY packages/@ezcorp/ai-kit/package.json packages/@ezcorp/ai-kit/
RUN bun install --production --frozen-lockfile

# Install web production dependencies (needed by SvelteKit server at runtime)
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --production --frozen-lockfile

# Copy backend source
COPY --from=builder /app/src ./src

# Phase 7 — make sure the netns launcher script is executable in the
# runtime image. `git` preserves the +x bit, but `COPY` from a build
# stage that may have applied tooling (linters etc.) needs an explicit
# chmod for the final image to spawn it via `unshare ... -- launcher.sh`.
RUN chmod +x /app/src/extensions/mcp-launcher.sh

# Copy @ezcorp/sdk workspace source — the package's "bun" exports condition
# points at ./src/index.ts, which runtime needs present since there's no built
# dist/ yet (Phase 3 will add the build step).
COPY --from=builder /app/packages/@ezcorp/sdk/src ./packages/@ezcorp/sdk/src

# Copy @ezcorp/ai-kit — its manifest + source load at runtime because ai-kit is
# a default-on bundled extension (see src/extensions/bundled.ts). The runtime
# needs the .ts config, src/, docs/, and skills/ — the `files` list in the
# package.json.
COPY --from=builder /app/packages/@ezcorp/ai-kit/src ./packages/@ezcorp/ai-kit/src
COPY --from=builder /app/packages/@ezcorp/ai-kit/ezcorp.config.ts ./packages/@ezcorp/ai-kit/ezcorp.config.ts
COPY --from=builder /app/packages/@ezcorp/ai-kit/scripts ./packages/@ezcorp/ai-kit/scripts
COPY --from=builder /app/packages/@ezcorp/ai-kit/docs ./packages/@ezcorp/ai-kit/docs
COPY --from=builder /app/packages/@ezcorp/ai-kit/skills ./packages/@ezcorp/ai-kit/skills

# Copy bundled extension definitions (needed by src/extensions/bundled.ts at runtime)
COPY --from=builder /app/docs ./docs

# Copy compiled SvelteKit app
COPY --from=builder /app/web/build ./web/build

# Create data directory for PGlite + backups. Declared as a VOLUME so users
# who don't bind-mount get a named docker volume automatically (data survives
# image upgrades). Default backup dir resolves to /app/data/backups via
# src/db/backup.ts:getBackupDir(), so one mount covers both.
#
# /app/.ezcorp is the per-project extension-data root (openai-image-gen-2
# writes generated PNGs there; rehydrator reads them on subsequent turns).
# It must exist in the image with bun ownership — otherwise the named-volume
# mount in compose.prod.yml creates the directory as root at runtime, and
# the unprivileged `bun` user can't mkdir extension-data/<name>/ inside it.
#
# chown to the `bun` user so the runtime (which runs unprivileged — see USER
# below) can write snapshots, backups, and the persistent encryption secret.
RUN mkdir -p /app/data /app/.ezcorp && chown -R bun:bun /app /app/data /app/.ezcorp
VOLUME /app/data
VOLUME /app/.ezcorp

EXPOSE 3000

ENV EZCORP_PORT=3000
ENV EZCORP_DB_PATH=/app/data/ezcorp

# Drop root. The oven/bun:1-slim base image ships a `bun` user (uid 1000); all
# files under /app are chowned to it above. Anything in a bind-mounted
# /app/data from the host must be readable + writable by uid 1000.
USER bun

# start-period=60s covers first-boot cost: migrate() + bundled-extension
# install + PGlite cold start. Shorter values flap "unhealthy" on slower
# hardware or the first volume-init.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/api/health'); process.exit(r.ok || r.status === 401 ? 0 : 1)" || exit 1

CMD ["bun", "run", "web/build/index.js"]
