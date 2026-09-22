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
# lock, and `scripts/check-factory-deployment-locks.ts` refuses a tag without one.
ARG BUN_IMAGE=docker.io/oven/bun:1.3.14@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834
ARG BUN_RUNTIME_IMAGE=docker.io/oven/bun:1.3.14-slim@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0
ARG NODE_IMAGE=docker.io/library/node:24.14.1-bookworm-slim@sha256:e484ae3f1e3c378021c967fd42254f343c302a9263e412280eac32bf5bca7008

FROM ${NODE_IMAGE} AS node

FROM ${BUN_IMAGE} AS builder
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
COPY . .
# Lifecycle scripts stay off: the root postinstall also installs git hooks,
# which have no repository here. The workspace builds it would have run are
# listed explicitly below, in dependency order.
RUN bun install --frozen-lockfile --ignore-scripts \
  && (cd web && bun install --frozen-lockfile --ignore-scripts)
RUN bun run --cwd packages/@ezcorp/sdk build \
  && bun run --cwd packages/@ezcorp/harness-client build \
  && bun run --cwd packages/@ezcorp/factory-sdk build \
  && bun run --cwd packages/@ezcorp/factory-transport build \
  && bun run --cwd packages/@ezcorp/factory-orchestrator build
RUN cd web && bun run build
# Nothing in the runtime needs the test trees or the coverage tooling.
RUN rm -rf web/.svelte-kit/output/client/_app/immutable/*.map coverage .git

FROM ${BUN_RUNTIME_IMAGE}
ARG REVISION=unknown
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
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
