# Production / Self-Hosted Deployment

Deploy EZCorp as a single Docker container backed by embedded PGlite, or swap
in an external Postgres once you outgrow it. Covers migration safety,
backups, auto-updates, and TLS.

## Prerequisites

- Docker with Docker Compose v2
- (Optional) Reverse proxy for HTTPS (Caddy, nginx)
- (Optional) PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) — only if you choose external DB

## 1. Quick start (embedded PGlite)

```bash
# 1. Seed the env file from the tracked template
cp .env.prod.example .env.prod
chmod 600 .env.prod

# 2. Generate the four required secrets and paste each into .env.prod
openssl rand -base64 32   # → EZCORP_ENCRYPTION_SECRET
openssl rand -base64 16   # → EZCORP_ENCRYPTION_SALT
openssl rand -base64 32   # → EZCORP_JWT_SECRET
# EZCORP_PUBLIC_URL = the URL you'll reach the app at, e.g.
#   https://ezcorp.example.com   (behind TLS reverse proxy)
#   http://localhost:4000        (LAN / single-host)

# 3. Start (note: --env-file feeds host-side ${VAR} interpolation;
#    env_file: in compose.prod.yml additionally injects the same values
#    into the container at runtime — both layers point at .env.prod)
docker compose --env-file .env.prod -f compose.prod.yml up -d
```

Open the URL you set in `EZCORP_PUBLIC_URL` (default host port `4000`)
and create the admin account.

`compose.prod.yml` declares `${VAR:?error}` for the four required secrets,
so `docker compose` aborts with a clear message if any are missing —
better than booting with auto-generated ephemeral secrets that would
break decrypts on the next restart.

> **Why `.env.prod` and not `.env`?** Keeping prod values in their own file
> avoids accidentally sourcing dev defaults from a stray `.env`, makes the
> intended permission posture (`chmod 600`) explicit, and lets you commit
> `.env.prod.example` as a checklist without ever risking the real file.

### Backing up the data volume

Everything stateful — PGlite database, pre-boot snapshots, periodic backups,
extension files — lives under the named volume `ezcorp-data`. `docker
compose down` preserves it; `docker compose down -v` destroys it. To copy
it off-host:

```bash
docker run --rm -v ezcorp-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ezcorp-data-$(date +%Y%m%d).tgz -C /data .
```

Restore by stopping the stack, untarring back into the volume, then
starting again. See §3 for snapshot-level recovery details.

### Environment variables

Set in `.env.prod` (gitignored). Required vars are enforced at compose-up
time via `${VAR:?...}` interpolation — missing any of them aborts the
deploy with an explanatory error.

| Variable                      | Required | Description                                                                                                     |
|-------------------------------|----------|-----------------------------------------------------------------------------------------------------------------|
| `EZCORP_ENCRYPTION_SECRET`    | **Yes**  | Encrypts stored OAuth tokens and provider API keys at rest. `openssl rand -base64 32`. Rotating it renders every stored credential unreadable. |
| `EZCORP_ENCRYPTION_SALT`      | **Yes**  | Paired with the secret for key derivation. `openssl rand -base64 16`. Same stability rules as the secret.       |
| `EZCORP_JWT_SECRET`           | **Yes**  | Signs session JWTs. `openssl rand -base64 32`. Rotating it logs every active user out.                          |
| `EZCORP_PUBLIC_URL`           | **Yes**  | Public-facing URL (drives `ORIGIN`). Without it, `svelte-adapter-bun`'s `get_origin()` defaults the scheme to `https` and breaks login over plain HTTP. |
| `FORCE_SECURE_COOKIES`        | No       | Set to `true` only when traffic reaches the app over HTTPS. Default: `false`.                                   |
| `EZCORP_PORT_HOST`            | No       | Host port published by Docker (container always listens on 3000). Default: `4000`.                              |
| `EZCORP_CHECK_UPDATES`        | No       | Set to `false` to disable the in-app update banner and GitHub Releases poll. Default: `true`.                   |
| `EZCORP_UPDATE_REPO`          | No       | `<owner>/<repo>` for the update check. Default: `ezcorp-org/EZcorp`.                                            |
| `EZCORP_SECRETS_DIR`          | No       | Directory for legacy auto-generated secret fallbacks (`.pi-secret`, `.pi-salt`). Default: parent of `EZCORP_DB_PATH`. |
| `EZCORP_DB_PATH`              | No       | DB directory inside the container (default: `/app/data/ezcorp`).                                                |
| `EZCORP_BACKUP_DIR`           | No       | Override the backup directory. Default: sibling `backups/` of the DB dir (`/app/data/backups` under defaults).  |
| `EZCORP_SCAN_GLOBAL_COMMANDS` | No       | Set to `0` to disable slash-command discovery from the server's home dir. **Recommended for multi-tenant.**     |
| `DATABASE_URL`                | No       | Use external Postgres instead of embedded PGlite (see §5).                                                      |

> **Never auto-generate the four required secrets in production.** The
> first-boot fallback writes them to `.pi-secret` / `.pi-salt` inside the
> data volume — fine for a one-off laptop demo, fatal anywhere else: a
> volume reset, a `down -v`, or a fresh host all silently mint new
> secrets and orphan every previously-stored OAuth token. Set them
> explicitly so the values are reproducible from your secret manager.

### When to flip `FORCE_SECURE_COOKIES`

Off by default so the LAN/single-host happy path works over plain HTTP.
Flip to `true` **only after** TLS is terminating in front of the app
(Caddy / nginx / cloud LB — see §6). Setting it without HTTPS makes
browsers refuse to send the session cookie back, and the symptom is an
infinite login loop rather than a clean error.

### Bind mounts and file ownership

The container runs as **uid 1000** (the `bun` user). If you bind-mount a host directory instead of using the named volume, it must be writable by uid 1000:

```bash
mkdir -p /srv/ezcorp-data && chown 1000:1000 /srv/ezcorp-data
docker run -v /srv/ezcorp-data:/app/data ghcr.io/ezcorp-org/ezcorp:latest
```

Named volumes (the default in `compose.prod.yml`) inherit ownership from the image, so this only matters for host-path mounts.

#### Fixing a pre-existing `ext-data` volume

Docker initializes a named volume from the image only on **first** creation.
If you deployed before the image pre-created `/app/.ezcorp`, the existing
`ext-data` volume is root-owned and the openai-image-gen extension fails
with `EACCES: permission denied, mkdir '/app/.ezcorp/extension-data'`. Fix
with a one-time chown — no data loss, no `down -v`:

```bash
docker compose -f compose.prod.yml run --rm --user 0 --entrypoint sh app \
  -c "chown -R bun:bun /app/.ezcorp"
docker compose -f compose.prod.yml up -d
```

## 2. Boot sequence and migration safety

Every boot runs through:

1. **Circuit-breaker check.** If the previous boot of this exact image SHA
   failed a migration, a marker file `/app/data/.migration-failed` is
   present. The container opens the DB without re-running migrations and
   reports `/api/ready` as 503 with `reason: "migration-blocked"`. The UI
   still loads so you can export data or roll back.
2. **Pre-migrate snapshot.** The DB directory is copied to
   `/app/data/backups/pre-boot-<sha>-<timestamp>/` (3 most recent kept) so
   there's always a known-good rollback target.
3. **Migrate.** Schema DDL is applied (idempotent — re-running is safe).
4. **On success:** stale failure markers are cleared, `/api/ready` flips to
   200, and the 30-minute interval backup timer starts.
5. **On failure:** the failed DB dir is renamed aside (`.failed.<ts>`), the
   latest pre-boot snapshot is restored, a failure marker is written, and
   the container exits with code 1. Docker's restart policy brings it back
   up — this time the circuit breaker kicks in and the app boots read-write
   (idempotent DDL won't be re-attempted).

### Verifying the snapshot + rollback path

Before relying on this in production, exercise the full flow with the
bundled verification scripts:

| Command                          | What it proves                                                                                        | Needs Docker |
|----------------------------------|-------------------------------------------------------------------------------------------------------|--------------|
| `bun run verify:backup`          | Happy path: snapshot → simulated migrate failure → rollback restores data → recovery works           | No           |
| `bun run verify:edges`           | Edge cases: stale marker, unset SHA, no-snapshot-available, pruning-to-3, malformed marker           | No           |
| `bun run verify:docker`          | Docker image: OCI labels, VOLUME, env baked in, readiness gate, version endpoint, persistence        | Yes          |
| `bun run verify:docker-rollback` | Docker rollback: marker-driven circuit breaker, degraded state, recovery via `docker exec`           | Yes          |
| `bun run verify:docker-upgrade`  | Two-image upgrade: A → B preserves data + takes a new snapshot + surfaces new version; A ← B documents downgrade behavior | Yes          |
| `bun run verify:all`             | Runs all five in sequence                                                                             | Yes          |

Each script exits non-zero on any failure and prints a green "VERIFIED"
banner on success. Wire `verify:all` into your CI pipeline or run it before
publishing a new image tag.

### Recovering from a failed migration

If `/api/ready` returns 503 with `reason: "migration-blocked"`:

**Option A — roll back to the previous image:**

```bash
# Edit compose.prod.yml: image: ghcr.io/ezcorp-org/ezcorp:<previous-tag>
docker compose -f compose.prod.yml up -d
```

**Option B — fix forward and reset the breaker:**

```bash
# Pull the new image that fixes the migration, then clear the marker
docker compose -f compose.prod.yml pull
docker exec <container> rm /app/data/.migration-failed
docker compose -f compose.prod.yml up -d --force-recreate
```

**Option C — export data and rebuild from the snapshot:**

The failed DB is retained at `/app/data/ezcorp.failed.<ts>/` for forensic
inspection. Pre-boot snapshots under `/app/data/backups/pre-boot-*/` can be
copied out with `docker cp`.

## 3. Backups

Two kinds of backups live under `/app/data/backups/`:

| Prefix        | Cadence                        | Retention | Purpose                                                          |
|---------------|--------------------------------|-----------|------------------------------------------------------------------|
| `pre-boot-`   | Every container start          | 3         | Rollback target if the next migration fails                      |
| `ezcorp-db-`  | Every 30 minutes while healthy | 5         | Point-in-time recovery, copied once more on graceful shutdown    |

> *Legacy:* instances upgraded from an earlier build may still carry `pi-db-*` entries. They count toward the 5-backup cap and age out on the same newest-first rotation — no manual cleanup needed.

Each is a full directory copy of the PGlite data (cheap — PGlite datasets
are typically under a few hundred MB). Restore by stopping the container,
replacing `/app/data/ezcorp/` with the contents of a snapshot, and
restarting.

```bash
# Example: restore from the most recent pre-boot snapshot
docker compose -f compose.prod.yml stop app
docker run --rm -v ezcorp-data:/data alpine sh -c \
  "rm -rf /data/ezcorp && cp -a /data/backups/pre-boot-*/ /data/ezcorp"
docker compose -f compose.prod.yml up -d
```

Move `EZCORP_BACKUP_DIR` to a separate mount (e.g. an NFS volume or S3-mounted
path) if you want off-host snapshots.

## 4. Auto-updates

### Notification (default on)

The in-app update banner polls `/api/version`, which once a day checks
GitHub Releases for the repo set in `EZCORP_UPDATE_REPO`. Result is cached
to `/app/data/.update-check.json` so restarts don't re-hammer the API.
Disable with `EZCORP_CHECK_UPDATES=false`.

### Automatic restart via Watchtower (opt-in)

Uncomment the `watchtower` service in `compose.prod.yml`. Watchtower polls
GHCR every 24 hours; when a new `:latest` image lands it pulls, stops, and
recreates the `app` container. The boot sequence then re-runs migrations
with the snapshot-and-rollback safety net above.

```bash
docker compose -f compose.prod.yml up -d
# Watchtower only acts on containers with the label
# `com.centurylinklabs.watchtower.enable=true` — already set on `app`.
```

### Tag strategy

- `ghcr.io/ezcorp-org/ezcorp:latest` — moves with every release. What
  Watchtower follows.
- `ghcr.io/ezcorp-org/ezcorp:x.y.z` — pinned. Pin this if you want to opt
  out of auto-updates while still running Watchtower for other services.

## 5. External Postgres

Once PGlite's single-writer / ~few-GB sweet spot isn't enough, switch to
external Postgres:

1. Provision a Postgres 15+ database with pgvector enabled:

   ```sql
   CREATE DATABASE ezcorp;
   \c ezcorp
   CREATE EXTENSION vector;
   ```

2. Uncomment the `postgres` service in `compose.prod.yml` (or point at an
   existing server), set `DATABASE_URL` on the `app` service, and restart.

3. The boot sequence still runs migrations, but snapshot/rollback is
   delegated to your Postgres backups (`pg_dump`, WAL archiving, etc.) —
   EZCorp's embedded snapshotting is PGlite-only.

```bash
pg_dump -U ezcorp ezcorp > ezcorp_backup_$(date +%Y%m%d).sql
```

## 6. Reverse proxy (HTTPS)

### Caddy (recommended)

```
ezcorp.example.com {
    reverse_proxy localhost:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name ezcorp.example.com;

    ssl_certificate     /etc/ssl/certs/ezcorp.pem;
    ssl_certificate_key /etc/ssl/private/ezcorp.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

WebSocket headers (`Upgrade`, `Connection`) are required for streaming chat.

## 7. Health vs readiness

Two orthogonal probes:

- **`GET /api/health`** — liveness. 2xx as soon as the HTTP listener is up.
  Used by Docker's `HEALTHCHECK`; should *not* gate traffic.
- **`GET /api/ready`** — readiness. 200 once migrations have succeeded;
  503 during boot or after a migration failure (with a JSON body describing
  the failure and recovery steps). Point orchestrators (Kubernetes readiness
  probe, external load-balancer) at this.

## 8. Security checklist

- [ ] `.env.prod` is `chmod 600` and owned by the user running Docker — and is **not** checked into version control (the repo's `.gitignore` already excludes `.env.*` while allowing `.env.*.example`).
- [ ] All four required secrets (`EZCORP_ENCRYPTION_SECRET`, `EZCORP_ENCRYPTION_SALT`, `EZCORP_JWT_SECRET`, `EZCORP_PUBLIC_URL`) are set explicitly — never relying on first-boot auto-generation in production.
- [ ] HTTPS terminated at the reverse proxy, then `FORCE_SECURE_COOKIES=true`.
- [ ] Firewall rules restrict DB / container ports to trusted networks.
- [ ] `EZCORP_SCAN_GLOBAL_COMMANDS=0` for multi-tenant deployments — the server's home-directory slash-command scan is shared across users. See [slash-commands.md](slash-commands.md#multi-tenant-deployments).
- [ ] Docker and base images kept current (Watchtower or manual).
- [ ] Review LLM provider API key scopes.

## 9. Known limitations

- `EZCORP_BACKUP_DIR` defaults to a sibling of the DB directory so a single
  mount covers both. Point it at a separate volume if you want backups
  isolated from primary storage.
- The circuit breaker keys on `EZCORP_IMAGE_SHA`, which is baked in at
  `docker build` time from the `REVISION` build-arg. Running under
  `docker compose` with a pre-built image honors it; running from source
  (`docker compose up --build` without passing `--build-arg REVISION=...`)
  disables the circuit breaker for that build.
