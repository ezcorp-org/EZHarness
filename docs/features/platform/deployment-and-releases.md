# Deployment & Releases

> _How EZCorp ships: a two-stage hardened Docker image, separate dev/prod Compose stacks, a tag-triggered release pipeline that verifies snapshot/rollback/upgrade before pushing multi-arch images to GHCR, and an in-app GitHub-Releases update check that surfaces a banner._

## Intent

EZCorp is a single-container, self-hosted platform, so the build/deploy story is part of the product. The image bakes in the MCP-sandbox runtime deps (namespaces, bubblewrap, seccomp BPF, a setuid preview helper), persists all DB state on a host bind mount, and refuses to boot prod with missing secrets. Releases are gated behind a verification pipeline (unit + snapshot/rollback + Docker upgrade) so a published image is provably upgrade-safe, and a lightweight update check tells running instances when a newer GitHub Release exists. The goal is zero-RPO local persistence and safe, observable upgrades for operators who run their own box.

## How it works

### Image build (two-stage `Dockerfile`)

1. **Stage 1 (`oven/bun:1` builder)** — installs root + `web/` deps (`--frozen-lockfile --ignore-scripts`), `COPY . .`, builds the `@ezcorp/sdk` workspace (`bun run --cwd packages/@ezcorp/sdk build`), then the SvelteKit app (`cd web && bun run build`).
2. **Stage 2 (`oven/bun:1-slim` runtime)** — apt-installs the MCP-sandbox runtime binaries (`util-linux`, `iproute2`, `iptables`, `nftables`, `libcap2-bin`, `bubblewrap`, `libseccomp2`), then does two self-contained compile-and-purge blocks (gcc + libs installed and removed in the same `RUN` so they never bloat the layer):
   - **seccomp BPF** — compiles `build/compile-seccomp.c` and transforms the committed `src/extensions/mcp-seccomp.json` profile into `/app/src/extensions/mcp-seccomp.bpf` (opened at MCP-spawn time, passed to `bwrap --seccomp <fd>`).
   - **preview-spawn helper** — compiles `build/preview-spawn.c` to `/app/bin/preview-spawn`, installed `root:root` mode `4755` (setuid). It lands **outside** the source tree on purpose — an extensionless ELF next to `preview-spawn.ts` would shadow the TS module and crash the preview subsystem at import.
3. Build-arg metadata (`VERSION`, `REVISION`, `CREATED`) is surfaced as OCI labels **and** as runtime env vars: `EZCORP_IMAGE_VERSION` (the version the update check reports as `current`) and `EZCORP_IMAGE_SHA` (the **circuit-breaker key** read by `src/db/connection.ts`).
4. Runtime deps are re-installed `--production`, backend `src/`, the SDK/ai-kit workspace source, bundled-extension `docs/` + `extensions/`, the tamper lockfile `manifest.lock.json`, and the compiled `web/build/` are copied in. `/app/data` + `/app/.ezcorp` are created and `chown`'d to `bun`; the setuid bit on `preview-spawn` is re-applied **after** the recursive chown (chown strips it).
5. Final posture: `USER bun` (uid 1000), `NODE_ENV=production` (closes the `/api/__test/**` surface), two `VOLUME`s, a `HEALTHCHECK` hitting `/api/health` (treats `401` as healthy), `CMD ["bun", "run", "web/build/index.js"]`.

### Compose stacks

- **Dev (`docker-compose.yml`, `Dockerfile.dev`)** — builds the dev image (deps incl. devDeps, **no** SvelteKit prod build; source bind-mounted for HMR). `network_mode: host`, a `pgvector/pgvector:pg16` Postgres sidecar (`DATABASE_URL` set), a one-shot seed (`bun src/db/seed-marketplace.ts` gated by a `.seeded` sentinel), `EZCORP_DEV_INDICATOR=1` (inverts the logo), and a SearXNG sidecar published on loopback `127.0.0.1:8889`.
- **Prod (`compose.prod.yml`, `Dockerfile`)** — distinct project name `ezcorp-prod`; default `build:` local image tagged `ezcorp:local` (override `EZCORP_IMAGE=ghcr.io/ezcorp-org/ezcorp:<tag>` to pull instead). Bridge networking, `cap_add: NET_ADMIN` (for the MCP netns/veth stack), `stop_grace_period: 30s` (the app's internal hard-timeout is 25s — see `web/src/lib/server/shutdown.ts`), and an `env_file: .env.prod`. **Fail-on-missing-secret**: required vars use `${VAR:?error}` interpolation so `docker compose up` aborts if `EZCORP_PUBLIC_URL` / `EZCORP_ENCRYPTION_SECRET` / `EZCORP_ENCRYPTION_SALT` / `EZCORP_JWT_SECRET` are unset (better than silently auto-generating ephemeral secrets that break decrypts on restart). All DB state + snapshots live on a host bind mount `./.ezcorp/data → /app/data` (survives `down -v`, `prune`, image upgrades). SearXNG is internal (`http://searxng:8080`, no published port); a commented-out Watchtower service (24h poll, opt-in by label) and a commented external-Postgres block are provided.

### Boot safety (`src/db/connection.ts`)

- **Circuit breaker** keyed on `EZCORP_IMAGE_SHA`: if `migrate()` failed on the prior boot of **this exact image** (a `.migration-failed` marker matching the SHA), boot skips migrate, opens the restored snapshot, and sets readiness `degraded / migration-blocked` so `/api/ready` returns 503. Disabled outside a built image (no SHA).
- A pre-boot snapshot is taken before open+migrate (rollback target, rotation of 3). Stale `postmaster.pid`/`postmaster.opts` locks (left by SIGKILL mid-flush) are cleared up front so they aren't misread as corruption.
- **Open-failure policy** is fail-loud by default: on a PGlite open failure it leaves the data alone, writes `/app/data/.ezcorp-recovery-needed.json`, and reports `/api/ready` 503 (`data-recovery-needed`). `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` restores the legacy rename-aside-and-start-fresh path (two 2026-05-10 data-loss incidents traced to the old always-on behavior; off is now mandatory).

### Release pipeline (`.github/workflows/release-image.yml`)

Triggered by pushing an `app-v*` tag (or `workflow_dispatch`):

1. **Tag↔version check** — `jq -r .version package.json` must equal the tag minus `app-v`, else fail fast before the expensive build (keeps the running image's `current` and the Release's `latest` in sync).
2. **Gate 1 — fast in-process verify:** unit tests (`db-backup`, `readiness`, `update-check`, `db-migrate-idempotent`, `encryption`) + web tests (`api-ready-version`, `update-banner-logic`); `bun run verify:backup` (snapshot+rollback happy path → `scripts/verify-backup-rollback.ts`) and `verify:edges` (circuit-breaker edges → `scripts/verify-circuit-breaker-edges.ts`).
3. **Gate 2 — Docker verify:** build the image locally (`load: true`, `ezcorp:verify`) with the derived build args, then run `scripts/verify-docker-image.sh --no-build` (labels / VOLUME / readiness / version), `scripts/verify-docker-rollback.sh` (circuit breaker + recovery), `scripts/verify-docker-upgrade.sh` (two-image data + snapshot preservation).
4. **Publish** — `docker/login-action` to GHCR, `docker/metadata-action` derives tags (`latest`, `app-v(.*)` match, semver `{{version}}` / `{{major}}.{{minor}}` / `{{major}}`, `sha-` prefix), then `docker/build-push-action` pushes **multi-arch** `linux/amd64,linux/arm64` with GHA buildx cache.
5. **Announce** — on a tag push only, `gh release create/edit` publishes the GitHub Release for the `app-v*` tag and marks it `--latest` (idempotent on re-run). This is the step that makes deployed instances aware a new version exists.

### Update check (`src/update-check.ts` → `/api/version` → banner)

- `getUpdateCheck()` reports `current = EZCORP_IMAGE_VERSION || "dev"`. Enabled when `EZCORP_CHECK_UPDATES !== "false"` **and** `EZCORP_UPDATE_REPO` is set; otherwise returns `source: "disabled"`.
- It polls `https://api.github.com/repos/<repo>/releases/latest` (5s timeout) and caches the result for **24h** in a `.update-check.json` next to the DB dir (or `$HOME/ez-corp/.data` for external/in-memory DBs). `compareVersions` extracts the first `N.N.N`-ish substring from each side, so any `app-v` / `v` prefix or `-rc`/`+build` suffix is ignored.
- `GET /api/version` (`web/src/routes/api/version/+server.ts`) just returns the `UpdateCheckResult`. The `UpdateBanner.svelte` (mounted in `web/src/routes/+layout.svelte`) fetches it; `UpdateBanner.helpers.ts#shouldShowBanner` renders only when `updateAvailable` and the user hasn't dismissed **that specific `latest`** (sessionStorage key `ezcorp-update-dismissed`, so a newer release re-shows).

## Usage

### Operator commands

```sh
# Prod: copy + fill secrets, pre-create the data dir, then up
cp .env.prod.example .env.prod      # fill EZCORP_PUBLIC_URL + the 3 secrets
mkdir -p .ezcorp/data && sudo chown -R 1000:1000 .ezcorp/data   # ONE TIME
docker compose -f compose.prod.yml up -d            # → http://localhost:4000

# Dev
docker compose up -d                                # network_mode: host, :3000

# Rebuild-from-source prod deploy (default build: flow)
docker compose -f compose.prod.yml up -d --build
```

### Cutting a release

```sh
# Bump package.json "version" to X.Y.Z, commit, then:
git tag app-vX.Y.Z && git push origin app-vX.Y.Z   # triggers release-image.yml
# Local pre-flight (mirrors the CI gates):
bun run verify:all   # verify:backup && verify:edges && verify:docker{,-rollback,-upgrade}
```

### HTTP surfaces

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness probe used by `HEALTHCHECK` (200, or **401 also treated healthy**). |
| `GET /api/ready` | Readiness — 200 `ready`, else **503** (`migration-blocked` / `data-recovery-needed`). Gate rollouts on this. |
| `GET /api/version` | Update-check result (`current`/`latest`/`updateAvailable`/`releaseUrl`/`source`). |

### Key env vars

| Var | Where | Effect |
|---|---|---|
| `EZCORP_IMAGE_VERSION` | Dockerfile (build-arg `VERSION`) | `current` version reported by the update check. |
| `EZCORP_IMAGE_SHA` | Dockerfile (build-arg `REVISION`) | Migration circuit-breaker key. |
| `EZCORP_CHECK_UPDATES` | compose.prod (default `true`) | `false` disables the poll + banner. |
| `EZCORP_UPDATE_REPO` | compose.prod (default `ezcorp-org/EZcorp`) | GitHub repo for `releases/latest`. |
| `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE` | compose.prod (default unset) | `1`/`true` restores destructive auto-recovery on PGlite open failure. |
| `EZCORP_IMAGE` | compose.prod (default `ezcorp:local`) | Pull a registry image instead of local build. |
| `EZCORP_PORT_HOST` | compose.prod (default `4000`) | Host port mapped to container `3000`. |
| `EZCORP_PUBLIC_URL` / `EZCORP_ENCRYPTION_SECRET` / `EZCORP_ENCRYPTION_SALT` / `EZCORP_JWT_SECRET` | `.env.prod` | **Required** — `${VAR:?}` aborts the deploy if missing. |
| `FORCE_SECURE_COOKIES`, `IDLE_TIMEOUT`, `EZCORP_SESSION_*` | compose.prod | Cookie/session tuning (HTTPS, SSE keep-alive). |

## Key files

- `Dockerfile` — two-stage prod image: builder + slim runtime, MCP-sandbox deps, seccomp-BPF + setuid `preview-spawn` compile-and-purge, OCI labels, `USER bun`, healthcheck.
- `Dockerfile.dev` — dev image (all deps incl. dev, no SvelteKit prod build, `git` for `installFromGit`, source bind-mounted at runtime).
- `docker-compose.yml` — dev stack: host networking, Postgres + SearXNG sidecars, seed sentinel, HMR bind mounts, `EZCORP_DEV_INDICATOR`.
- `compose.prod.yml` — prod stack: local-build-or-pull, `NET_ADMIN`, fail-on-missing-secret interpolation, host bind-mount persistence, `stop_grace_period: 30s`, commented Watchtower + external-Postgres.
- `.github/workflows/release-image.yml` — `app-v*`-triggered release: tag↔version check, Gate 1/2 verify, multi-arch GHCR push, GitHub Release.
- `src/update-check.ts` — `getUpdateCheck`/`compareVersions`; 24h `.update-check.json` cache; polls GitHub `releases/latest`.
- `web/src/routes/api/version/+server.ts` — `GET /api/version` returning the update-check result.
- `web/src/lib/components/UpdateBanner.svelte` — fetches `/api/version`, renders the banner.
- `web/src/lib/components/UpdateBanner.helpers.ts` — `shouldShowBanner` / `dismissValue` pure logic (per-`latest` dismissal).
- `web/src/routes/+layout.svelte` — mounts `UpdateBanner`.
- `web/src/routes/api/ready/+server.ts` — readiness probe (503 when degraded).
- `web/src/routes/api/health/+server.ts` — liveness probe used by `HEALTHCHECK`.
- `src/db/connection.ts` — migration circuit breaker (`EZCORP_IMAGE_SHA`), pre-boot snapshot, fail-loud open-failure policy.
- `scripts/verify-backup-rollback.ts` — `verify:backup` snapshot+rollback happy path.
- `scripts/verify-circuit-breaker-edges.ts` — `verify:edges` circuit-breaker edge cases.
- `scripts/verify-docker-image.sh` — image label/VOLUME/readiness/version assertions.
- `scripts/verify-docker-rollback.sh` — Docker rollback (circuit breaker + recovery) verify.
- `scripts/verify-docker-upgrade.sh` — two-image upgrade data + snapshot preservation.
- `build/compile-seccomp.c` / `src/extensions/mcp-seccomp.json` — build-time JSON→BPF seccomp profile.
- `build/preview-spawn.c` — setuid `preview-spawn` helper source.
- `manifest.lock.json` — bundled-extension tamper lockfile baked at `/app`.

## Features it touches

- [[database-and-migrations]] — the circuit breaker, pre-boot snapshot, and fail-loud open-failure policy all live in the boot/migrate path; `verify:edges` exercises them.
- [[dev-lifecycle-and-gates]] — the release pipeline's Gate 1/2 verify suite is the deployment-side counterpart to the per-PR CI gates.
- [[sandbox-and-isolation]] — the image bakes in the namespace/bwrap/seccomp/nftables deps and `NET_ADMIN` posture that the MCP sandbox needs at runtime.
- [[preview-port-exposure]] — the setuid `/app/bin/preview-spawn` helper compiled by the Dockerfile is what launches per-conversation preview processes.
- [[mcp-servers]] — `cap_add: NET_ADMIN` + the seccomp BPF blob exist to isolate stdio MCP servers per spawn.
- [[web-search]] — both Compose stacks ship the SearXNG sidecar (loopback in dev, bridge-internal in prod).
- [[authentication]] — prod refuses to boot without `EZCORP_JWT_SECRET` / encryption secrets, and `FORCE_SECURE_COOKIES` / `ORIGIN` are deploy-time session config.
- [[bundled-catalog]] — `manifest.lock.json` + the bundled `docs/`/`extensions/` copies are baked into the image; a release that widens a bundled manifest disables that extension pending re-approval.
- [[audit-and-observability]] — `/api/ready` degraded states and MCP isolation fallbacks surface as readiness + `audit_log` rows for fleet monitoring.
- [[settings-system]] — `EZCORP_CHECK_UPDATES` / `EZCORP_UPDATE_REPO` are operator env knobs governing the in-app update banner.

## Related docs

- [deployment](../../deployment.md) — operator-facing container networking, MCP kernel/cap requirements, kill-switches, image size, web-search sidecar.
- [production-guide](../../production-guide.md) — backups, migration safety, auto-updates, external Postgres, bind-mount ownership, TLS reverse-proxy.
- [update-check](../../update-check.md) — the update-check contract and "Releasing a new version" runbook.
- [quick-start](../../quick-start.md) — end-user / dev-machine setup.

## Notes & gotchas

- **`app-v*` tag must match `package.json` `version`.** The pipeline fails fast otherwise (current `version` is `1.3.0`). Bump `package.json` and re-tag rather than force the tag.
- **Setuid bit is re-applied after `chown -R`.** The recursive `chown -R bun:bun /app` strips `preview-spawn`'s root ownership/setuid; a second `chown root:root` + `chmod 4755` after it is load-bearing — reordering breaks preview isolation silently.
- **`preview-spawn` must stay out of the source tree.** App modules import `./preview-spawn` extensionless; an ELF named `preview-spawn` beside `preview-spawn.ts` makes Bun parse the binary as JS and crash the preview subsystem at import. It lives at `/app/bin/`.
- **`network_mode: host` is dev-only.** Prod must use bridge/isolated networking; the SearXNG default URL differs per stack (`http://localhost:8889` dev vs `http://searxng:8080` prod).
- **Prod data persistence is a host bind mount, not a docker volume.** `./.ezcorp/data` survives `down -v`/`prune`/upgrades but the missing source is auto-created `root`-owned by Docker — pre-create + `chown 1000:1000` once or the unprivileged `bun` runtime can't write it.
- **`EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE` is dangerous.** Leave it unset in prod; `1`/`true` renames a failed-open data dir aside and starts empty (the cause of two 2026-05-10 data-loss incidents). Default is fail-loud + `/api/ready` 503.
- **Liveness vs readiness are orthogonal.** `HEALTHCHECK`/`/api/health` answers "can the process serve HTTP" (and treats `401` as healthy); `/api/ready` answers "did migrate() succeed and is this image safe to route to". Gate rollouts (Watchtower/K8s) on `/api/ready`, not `/api/health`.
- **Watchtower is commented out by default.** Self-hosters are nudged toward the in-app banner; auto-restart-on-new-tag is opt-in and only relevant once `EZCORP_IMAGE` points at a registry tag (not the default local build).
- **Update check needs both signals.** `EZCORP_UPDATE_REPO` unset (or `EZCORP_CHECK_UPDATES=false`) returns `source: "disabled"` and never shows the banner; a non-OK GitHub fetch falls back to the cached `latest` and logs a warning rather than erroring.
- **`current` is the build-arg version.** On an un-built/source-tree run `EZCORP_IMAGE_VERSION` is unset, so `current` reports `dev` and the update check never claims an upgrade is available.
