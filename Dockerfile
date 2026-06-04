# Stage 1: Build
FROM oven/bun:1 AS builder
WORKDIR /app

# Install root dependencies
COPY package.json bun.lock ./
# Workspace package.json files must be present before `bun install` can resolve
# `workspace:*` specifiers. Only the manifest is needed here — source lands later.
COPY packages/@ezcorp/sdk/package.json packages/@ezcorp/sdk/
COPY packages/@ezcorp/ai-kit/package.json packages/@ezcorp/ai-kit/
# `--ignore-scripts`: the @ezcorp/sdk `prepare` script (and root `postinstall`)
# compile the SDK to dist/ via tsc, but the SDK source + tsconfig.build.json
# haven't been COPY'd yet (only the package.json). Skip lifecycle here; we
# explicitly run the SDK build below after `COPY . .` so SvelteKit's bundler
# can resolve @ezcorp/sdk via the `import` exports condition (./dist/...).
RUN bun install --frozen-lockfile --ignore-scripts

# Install web dependencies
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile --ignore-scripts

# Copy source and build
COPY . .
# Explicitly build the SDK now that source + tsconfig are present. SvelteKit's
# build (next line) needs the dist/ to exist for any non-bun-condition import
# resolver. Skipped at install-time above due to layer-cache constraints.
RUN bun run --cwd packages/@ezcorp/sdk build
RUN cd web && bun run build

# Stage 2: Runtime
FROM oven/bun:1-slim
WORKDIR /app

# Phase 7 (MCP isolation) + Phase 55 Stage 1 (DNS rebind / tmpfs / seccomp
# log-mode) + Phase 58 Stage 2 (netns veth-pair + nftables egress filter)
# runtime dependencies. `oven/bun:1-slim` is debian-bookworm and ships
# without these; the namespace launcher (`src/extensions/mcp-launcher.sh`)
# needs all of them:
#   - util-linux  →  `unshare`, `prlimit`, `capsh`
#   - iproute2    →  `ip` (bring up loopback inside the netns; Phase 58
#                    `ip link set <ns> netns <pid>` + per-veth setup)
#   - iptables    →  `iptables-restore` (apply OUTPUT-DROP DROP-ALL
#                    inside the netns; defense-in-depth on top of the
#                    network namespace's own missing upstream interface)
#   - nftables    →  Phase 58 / MCP-05: in-namespace `nft -f -` heredoc
#                    that drops all egress except tcp to the bridge
#                    gateway (`10.42.0.1:<proxy-port>`)
#   - libcap2-bin →  `capsh` runtime
#   - bubblewrap  →  Phase 55 / MCP-02: declarative tmpfs + seccomp loader
#                    (`bwrap --tmpfs /tmp` + `--seccomp <fd>`)
#   - libseccomp2 →  Phase 55 / MCP-03: shared lib bwrap dlopens when
#                    applying the compiled cBPF profile in log-mode
#
# Image growth: ~26 MB (Phase 55 baseline ~23 MB + Phase 58 nftables ~3 MB).
# We need the runtime binaries in the final image (not just at build time)
# because each MCP spawn shells out to them.
#
# Kernel knob requirement (NOT installable via apt): the host kernel
# must allow unprivileged user namespace creation. Either set
# `kernel.unprivileged_userns_clone=1` (legacy) or run the container
# with `--cap-add=NET_ADMIN`. Phase 58 also requires `--cap-add=NET_ADMIN`
# for `ip link add type veth` + `ip link set master <bridge>` — without
# it Stage 2 degrades to Stage 1 (see `docs/deployment.md`).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       util-linux \
       iproute2 \
       iptables \
       nftables \
       libcap2-bin \
       bubblewrap \
       libseccomp2 \
  && rm -rf /var/lib/apt/lists/*

# Phase 55 / MCP-03 — Compile the seccomp BPF blob from the committed JSON
# profile. Build deps (gcc + libseccomp-dev) are apt-installed for the
# duration of this RUN and purged immediately, so they never bloat the
# runtime image. The resulting `/app/src/extensions/mcp-seccomp.bpf`
# survives in the final image; the launcher opens it at MCP-spawn time
# and passes the FD to `bwrap --seccomp <fd>`.
#
# The source-of-truth profile (`src/extensions/mcp-seccomp.json`) is
# committed to the repo; `scripts/check-seccomp-bpf-fresh.sh` is the CI
# guard against artifact drift if the BPF blob is also committed.
#
# Build-stage tokens this block contains (asserted by W2 Dockerfile-shape
# tests in `src/__tests__/mcp-seccomp-profile.test.ts`):
#   - literal "gcc" + "-lseccomp"
#   - the compile invocation referencing both mcp-seccomp.json and
#     mcp-seccomp.bpf so the JSON→BPF transformation is grep-discoverable.
COPY --from=builder /app/src/extensions/mcp-seccomp.json /tmp/mcp-seccomp.json
COPY --from=builder /app/build/compile-seccomp.c /tmp/compile-seccomp.c
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       gcc libseccomp-dev libc6-dev \
  && gcc -O2 -o /tmp/compile-seccomp /tmp/compile-seccomp.c -lseccomp \
  && mkdir -p /app/src/extensions \
  && /tmp/compile-seccomp /tmp/mcp-seccomp.json /app/src/extensions/mcp-seccomp.bpf \
  && apt-get purge -y --auto-remove gcc libseccomp-dev libc6-dev \
  && rm -rf /var/lib/apt/lists/* /tmp/compile-seccomp /tmp/compile-seccomp.c /tmp/mcp-seccomp.json

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
# `--ignore-scripts`: prevents the SDK's `prepare` (build) from running.
# Two reasons: (1) the SDK source isn't COPY'd into this stage (only its
# manifest), and (2) `--production` skips devDependencies including
# typescript, so tsc wouldn't be available even if source were present.
# Runtime resolves @ezcorp/sdk via the "bun" exports condition (raw .ts),
# so dist/ isn't needed in the runtime image — see the COPY of /src below.
RUN bun install --production --frozen-lockfile --ignore-scripts

# Install web production dependencies (needed by SvelteKit server at runtime)
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --production --frozen-lockfile --ignore-scripts

# Copy backend source
COPY --from=builder /app/src ./src

# Phase 7 — make sure the netns launcher script is executable in the
# runtime image. `git` preserves the +x bit, but `COPY` from a build
# stage that may have applied tooling (linters etc.) needs an explicit
# chmod for the final image to spawn it via `unshare ... -- launcher.sh`.
RUN chmod +x /app/src/extensions/mcp-launcher.sh

# Secure Preview / Phase 3a (uid-based portable isolation) — compile the
# setuid-root `preview-spawn` helper and install it root:root mode 4755.
#
# The non-root app (uid 1000) execs this tiny C helper to launch untrusted
# dev servers as a per-conversation "preview uid" (90000–99000). Because
# the binary is setuid-root and the container's root mount is not nosuid
# (NoNewPrivs=0), the app gains euid=0 just long enough for the helper to
# setgid+setuid down to the preview uid, drop all caps + supplementary
# groups, chdir into the conversation workdir, apply a restricted env, and
# execvp the dev server — with NO container posture change (no privileged,
# no userns, no extra caps). See tasks/preview-port-exposure.md "Phase 3
# REDESIGN".
#
# CRITICAL — the binary MUST land OUTSIDE the source tree. App modules
# import the TS driver extensionless (`import … from "./preview-spawn"`), so
# an extensionless ELF at src/runtime/preview/preview-spawn SHADOWS
# preview-spawn.ts in the image: bun parses the ELF as JS and crashes the
# whole dynamic-preview subsystem at import time. We install at /app/bin/
# (no .ts siblings) and previewSpawnHelperPath() defaults to that path.
#
# Build deps (gcc + libc6-dev) are installed for the duration of this RUN
# and purged immediately so they never bloat the runtime image — same
# pattern as the seccomp compile above. The source-of-truth C lives at
# build/preview-spawn.c (committed, auditable, < 200 lines).
#
# mode 4755 = rwsr-xr-x: setuid bit + world-exec so uid 1000 can invoke it;
# owned root:root so the setuid actually grants euid=0. The uid-range
# allowlist is enforced INSIDE the helper (and again on the TS side) so a
# 4755 binary can ONLY ever drop to a preview uid, never escalate.
COPY --from=builder /app/build/preview-spawn.c /tmp/preview-spawn.c
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && mkdir -p /app/bin \
  && gcc -O2 -Wall -Wextra -o /app/bin/preview-spawn /tmp/preview-spawn.c \
  && chown root:root /app/bin/preview-spawn \
  && chmod 4755 /app/bin/preview-spawn \
  && apt-get purge -y --auto-remove gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/* /tmp/preview-spawn.c

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

# Phase 53 bundled extensions (lessons-distiller, memory-extractor) live at
# extensions/<name>/ rather than docs/extensions/examples/<name>/. Without
# this COPY, src/extensions/bundled.ts:393,428 resolves the path to
# /app/extensions/<name>/ezcorp.config.ts which doesn't exist, install fails,
# and the boot-spawn helper silently skips both — distillation and memory
# extraction never run for any user.
COPY --from=builder /app/extensions ./extensions

# Bundled-extension tamper lockfile. src/extensions/bundled-lock.ts opens
# /app/manifest.lock.json on every boot and fails-closed when missing —
# logged as `Manifest tamper detected for bundled extension <name>`. The
# tamper branch in bundled.ts:626-651 short-circuits the manifest refresh,
# which in turn blocks the eventSubscriptions auto-heal from updating the
# DB grant. Symptom: POSTs to `/api/extensions/<name>/events/<event>` 404.
COPY --from=builder /app/manifest.lock.json ./manifest.lock.json

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

# Re-establish the setuid-root preview-spawn helper AFTER the recursive
# `chown -R bun:bun /app` above, which would otherwise strip its root
# ownership (a setuid binary owned by `bun` yields euid=1000 — useless).
# This restores root:root + the 4755 setuid bit so the helper grants euid=0
# when uid 1000 execs it. MUST stay after the chown. Path is /app/bin/ (out
# of the src tree) to avoid shadowing preview-spawn.ts — see the compile
# step above.
RUN chown root:root /app/bin/preview-spawn \
  && chmod 4755 /app/bin/preview-spawn

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
