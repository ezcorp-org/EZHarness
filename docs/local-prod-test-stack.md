# Local prod test stack

Runs the **production image** — built, no HMR, no source mounts, so code edits
do nothing until you rebuild — against a **throwaway copy of your dev
database**, on its own port, alongside the dev stack.

Use it to validate real prod behaviour with realistic data. It is **not** a
production deployment; see [production-guide.md](production-guide.md) for that.
A few pieces here trade security for convenience and are flagged inline.

Everything below is host-agnostic. Substitute:

| Placeholder | Meaning | Example |
|---|---|---|
| `<host>` | Hostname you reach the app at | `localhost`, `dev.internal` |
| `<host-ip>` | IP of the machine running the stack | `127.0.0.1`, `10.0.0.5` |
| `<bind-ip>` | Interface test ports publish on | `127.0.0.1` (default, this machine only) |

---

## 1. One-time setup

```bash
# Secrets. Reuse the DEV stack's encryption/JWT values if you want credentials
# in the copied database to decrypt and existing sessions to stay valid.
cp .env.prod.example .env.prod    # then fill in the required secrets

# Pre-create the data dir owned by the image's runtime uid (1000). Docker would
# otherwise create it as root, which the unprivileged runtime can't write.
mkdir -p .ezcorp/data && sudo chown -R 1000:1000 .ezcorp/data
```

If you want agents to build things in mounted projects, grant shared-group
write once — the image runs as **uid 1000**, which is usually *not* your login
user, so a plain bind mount is read-only in practice and agents fail silently:

```bash
sudo chgrp -R 1000 projects
sudo chmod -R g+rwX projects
sudo find projects -type d -exec chmod g+s {} +   # new files inherit the group
```

---

## 2. Make the test database

The stack reads database `ezcorp_prodtest`, an isolated copy that lives in the
**dev** stack's Postgres container. The live dev database is never touched.
Re-run this whenever you want fresh data:

```bash
docker exec <dev-postgres-container> sh -c '
  set -e
  pg_dump -U ezcorp -d ezcorp -f /tmp/ezcorp.dump.sql
  dropdb -U ezcorp --force --if-exists ezcorp_prodtest
  createdb -U ezcorp -T template0 ezcorp_prodtest
  psql -U ezcorp -d ezcorp_prodtest -v ON_ERROR_STOP=1 -q -f /tmp/ezcorp.dump.sql
'
```

The dev Postgres must be running and publishing `:5432` — that's how the prod
container reaches it via `host.docker.internal`.

> **Shared cookies:** cookies ignore ports, so browsing both stacks on the same
> hostname shares one session cookie, and a session refresh on one can log you
> out of the other. Use a different hostname for one of them if that bites.

---

## 3. Start it

```bash
EZCORP_PUBLIC_URL=http://<host>:4000 docker compose --env-file .env.prod \
  -f compose.prod.yml \
  -f compose.prod.devdb.yml \
  -f compose.prod.localtest.yml \
  up -d
```

Stop it (keeps all data):

```bash
EZCORP_PUBLIC_URL=http://<host>:4000 docker compose --env-file .env.prod \
  -f compose.prod.yml -f compose.prod.devdb.yml -f compose.prod.localtest.yml down
```

Rebuild after a code change — the image is built, so **nothing** you edit takes
effect without this:

```bash
… up -d --build app
```

> **Why `EZCORP_PUBLIC_URL` is on the command line:** `.env.prod` typically pins
> it to whatever host the *dev* stack uses. The shell value wins for `${VAR}`
> interpolation, and `compose.prod.yml`'s `environment:` map overrides what
> `env_file:` injects, so the container ends up with the right value. Get this
> wrong and the app serves on one port while advertising another — logins look
> fine, then break.

### The compose files

| File | Adds |
|---|---|
| `compose.prod.yml` | The real prod stack: built image, unprivileged uid 1000, searxng + ollama sidecars, `4000:3000` |
| `compose.prod.devdb.yml` | Points the app at external Postgres `ezcorp_prodtest` instead of embedded PGlite |
| `compose.prod.localtest.yml` | Mounts projects, publishes agent-server ports, sets `HOST=0.0.0.0` |

Drop the third file for clean prod parity: no project mounts, no extra ports.

Knobs for the third file (environment or `.env.prod`):

| Variable | Default | Purpose |
|---|---|---|
| `EZCORP_TEST_BIND_IP` | `127.0.0.1` | Interface the test ports publish on |
| `EZCORP_TEST_PRIMARY_PORT` | `8000` | Host port mapped to container `8000` |

---

## 4. Reaching servers an agent builds

Two independent paths. The proxy is the **secure** one; direct ports are the
**deterministic** one.

### Direct ports

| Agent listens on | Reachable at |
|---|---|
| **8000** | `http://<bind-ip>:${EZCORP_TEST_PRIMARY_PORT}` |
| 8002–8010 | `http://<bind-ip>:<port>` |
| 5173–5175, 4321, 3001–3002 | `http://<bind-ip>:<port>` — framework defaults, so an agent that ignores the convention still lands somewhere reachable |

Two hard requirements, both easy to trip:

- **The server must bind `0.0.0.0`.** Docker forwards a published port to the
  *container's* interface, so a `127.0.0.1`-bound server inside the container is
  invisible. `vite`/`astro` need `--host 0.0.0.0`; `Bun.serve` needs
  `hostname: "0.0.0.0"`. `HOST`/`HOSTNAME` are preset for tooling that reads them.
- **Port 3000 can never work** — the platform listens there, so an agent binding
  it dies with `EADDRINUSE`.

If `up` fails with *"address already in use"* on the primary port, something
else on the host owns it (a reverse proxy, a VPN's built-in proxy, another
stack). Set `EZCORP_TEST_PRIMARY_PORT` to a free host port instead of fighting
for it — the container side stays 8000 either way.

> **Security:** this bypasses consent, tokens, per-user isolation, and rate
> caps. Anything served here is reachable by anything that can reach
> `EZCORP_TEST_BIND_IP`. The default keeps that to this machine. Widen it
> deliberately; for a multi-user or internet-facing deploy, delete the block.

### The consent-gated preview proxy

The real feature
([features/tools/preview-port-exposure.md](features/tools/preview-port-exposure.md)):
agent starts a dev server → auto-detected → consent card in chat → served on
`<preview-id>.preview.<host>` behind a short-lived signed token.

Enable it in `.env.prod` (gitignored, so a fresh clone lacks it):

```
EZCORP_PREVIEW_APP_HOST=auto
```

`auto` derives the wildcard parent from `EZCORP_PUBLIC_URL`, so previews follow
whatever host the deploy is served on. Unset ⇒ preview origin fully disabled
(fail-closed, deliberate).

It needs **wildcard DNS** for `*.preview.<host>`. Pick whichever fits:

**a) `<host>` is `localhost` — nothing to do.** Browsers resolve `*.localhost`
to loopback themselves. Simplest option for single-machine use.

**b) Per-preview hosts entry** — fine for one-off checks, no infrastructure:

```bash
echo "<host-ip>  <preview-id>.preview.<host>" | sudo tee -a /etc/hosts
```

**c) Wildcard resolver + split DNS** — needed for real wildcard support on a
named host. A scoped CoreDNS sidecar is included
(`deploy/preview-dns/Corefile`, fully env-driven):

```bash
docker run -d --name ezcorp-preview-dns --restart unless-stopped \
  -e EZCORP_PREVIEW_ZONE=preview.<host> \
  -e EZCORP_PREVIEW_TARGET_IP=<host-ip> \
  -p <bind-ip>:53:53/udp -p <bind-ip>:53:53/tcp \
  -v "$PWD/deploy/preview-dns/Corefile:/Corefile:ro" \
  coredns/coredns:1.11.3 -conf /Corefile
```

Then point your resolver at it **for that zone only**, so every other lookup
keeps flowing through its normal path:

- *dnsmasq:* `server=/preview.<host>/<host-ip>`
- *systemd-resolved:* `DNS=<host-ip>` + `Domains=~preview.<host>`
- *Tailscale:* admin console → DNS → Nameservers → Add nameserver → Custom →
  Restrict to domain
- *VPN/corporate DNS:* a conditional-forwarding rule for the zone

The resolver answers only that zone and REFUSEs everything else, so it can't be
used as an open resolver or amplification reflector.

> If a VPN or reverse proxy already terminates TLS on a port, you can front the
> stack with it instead of publishing ports directly — map the container port to
> whatever host port that proxy forwards to via `EZCORP_TEST_PRIMARY_PORT`.

### Which commands trigger detection

`detectDevServerCommand` is a conservative allowlist and **bails on any shell
metacharacter**, so `cd app && bun dev` is *not* detected.

| Detected | Not detected |
|---|---|
| `bun dev`, `bun run dev`, `npm run dev` | `bun -e '…'` |
| `vite`, `next dev`, `astro dev` | `python3 -m http.server 8000` |
| `bunx serve`, `bunx serve -l 8000` | `bunx serve .` (positional path arg) |
| `bunx http-server`, `npx serve` | `cd app && bun dev` |

---

## 5. Gotchas

- **Never set `PORT` in the container.** It looks like the natural companion to
  `HOST`, but `svelte-adapter-bun` reads `PORT` for the *app's own* listener —
  setting it moves the platform off `:3000` and silently breaks the `4000:3000`
  publish, taking the whole UI down. Use `EZCORP_PORT`.
- **Project paths come from the copied database** and are absolute container
  paths. This overlay used to carry its own `EZCORP_TEST_PROJECTS_DIR` mount at
  `/app/projects` purely so those rows resolved; it no longer does, because the
  dev and prod stacks now bind the SAME path
  (`./.ezcorp/projects` → `/app/web/.ezcorp/projects`) and `compose.prod.yml`
  supplies it. If a row still points somewhere else, the symptom misleads: the
  shell tool spawns with `cwd=<missing dir>`, which surfaces as
  `posix_spawn '/bin/sh' — ENOENT`, plus `Path traversal detected` from the file
  tools. A **relative** path in a `projects.path` row fails the same way; new
  writes are now rejected by `projectPathSchema`, but rows predating it survive.
- **Any container recreate kills running agent servers** — rebuilds, `up -d`
  after a config change, restarts. Re-run the dev server afterwards.
- **Extension-data ownership.** If a root-running dev stack shares
  `.ezcorp/extension-data`, prod (uid 1000) hits `EACCES … /.daemon.pid` at
  boot. Fix: `sudo chown -R 1000:1000 .ezcorp/extension-data .ezcorp/extensions`.
- **Embeddings are broken in the prod image** (as of 2026-07). `ssr.external` in
  `web/vite.config.ts` is ignored and `@huggingface/transformers` is inlined into
  the SSR bundle as the *browser* build, so model paths resolve as URLs
  (`Unable to load from local path "/models/…" fetch() URL is invalid`) and the
  load never completes. It fails **silently** — memory retrieval and semantic
  search degrade with no error. Dev is unaffected (raw TS, no bundling).
- **`global:systemPrompt` is a fallback, not a merge.** Prompt resolution is
  `conversation` → `project:<id>` → `global`, so a conversation with its own
  `systemPrompt` ignores the global one entirely. Worth knowing if you use it to
  teach agents the port convention.

---

## 6. Health checks

```bash
curl -s localhost:4000/api/ready                          # {"state":"ready",…}
docker compose … ps                                       # app healthy
docker port <app-container>                               # port map intact
docker exec <app-container> sh -c 'ls /app/web/.ezcorp/projects'   # mounts present

# Preview origin live? 404 = the proxy handled it; 302 = feature disabled.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Host: abcdefghjkmnpqrstvwxyz0123.preview.<host>:4000" http://localhost:4000/
```
