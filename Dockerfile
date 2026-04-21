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

# Copy TESTENV project directory
COPY --from=builder /app/TESTENV ./TESTENV

# Create data directory for PGlite storage
RUN mkdir -p /app/data

EXPOSE 3000

ENV EZCORP_PORT=3000
ENV EZCORP_DB_PATH=/app/data/ezcorp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/api/health'); process.exit(r.ok || r.status === 401 ? 0 : 1)" || exit 1

CMD ["bun", "run", "web/build/index.js"]
