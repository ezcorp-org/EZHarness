# The factory runtime image: one image, four entry points.
#
# The self-hosted Compose profile and the hosted Kubernetes profile both run
# this image. Each service selects its own entry point:
#
#   harness       bun web/build/index.js            (the product process)
#   orchestrator  node src/factory/orchestration-process.ts
#   pool          bun src/factory/pool/process.ts
#   gateway       bun src/factory/gateway-process.ts
#
# The host supervisor is NOT run from this image in the Compose profile. C05
# places it outside every container as a host systemd unit, and it runs from the
# same source revision checked out on the host. In the Kubernetes profile the
# supervisor DaemonSet runs this image with the container runtime socket; no
# other workload receives that socket.
#
# Every base image is pinned by digest. `docs/factory-deployment.md` names the
# lock, and `scripts/check-factory-deployment-locks.ts` (run in CI) refuses an image without one.
ARG BUN_IMAGE=docker.io/oven/bun:1.4.2@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2
ARG BUN_RUNTIME_IMAGE=docker.io/oven/bun:1.4.2-slim@sha256:debbe76858f2e398d2937c1eceeb82c571ac1fcd78aadf00e9634578ac2b5ef7
ARG NODE_IMAGE=docker.io/library/node:24.14.1-bookworm-slim@sha256:e484ae3f1e3c378021c967fd42254f343c302a9263e412280eac32bf5bca7008

FROM ${NODE_IMAGE} AS node

FROM ${BUN_IMAGE} AS builder
# Bun 1.4.0-1.4.2: Postgres auto-pipelining off at process start (src/db/bun-sql-pipelining.ts refuses Bun.SQL otherwise).
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1
WORKDIR /app
COPY . .
# Lifecycle scripts stay off: the root postinstall also installs git hooks,
# which have no repository here. Its workspace builds run below through the
# same root script (scripts/build-workspace-packages.ts derives the order).
RUN bun install --frozen-lockfile --ignore-scripts \
  && (cd web && bun install --frozen-lockfile --ignore-scripts)
RUN bun run build:packages
RUN cd web && bun run build
# Nothing in the runtime needs the test trees or the coverage tooling.
RUN rm -rf web/.svelte-kit/output/client/_app/immutable/*.map coverage .git
# Every service runs as the host user's uid (keep-id), which owns no file in the
# image. A build context exported under a private umask arrives 0600/0700, so
# the tree is made world-readable (and directories traversable) here; nothing
# in it is a secret, and nothing in it is writable by the services.
RUN chmod -R a+rX,go-w /app

FROM ${BUN_RUNTIME_IMAGE}
ARG REVISION=unknown
# Bun 1.4.0-1.4.2: Postgres auto-pipelining off at process start (src/db/bun-sql-pipelining.ts refuses Bun.SQL otherwise).
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 \
    NODE_ENV=production \
    EZCORP_IMAGE_SHA=${REVISION}
LABEL org.opencontainers.image.title="ezcorp-factory" \
      org.opencontainers.image.revision=${REVISION}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /app /app
WORKDIR /app
# The Compose profile runs every service with the host user's own uid
# (`userns_mode: keep-id`), because the private-file reader requires each secret
# to be owned by the reading process. The image therefore owns nothing it must
# write: every writable path is a tmpfs or a named volume declared by the profile.
USER 65534:65534
CMD ["bun", "web/build/index.js"]
