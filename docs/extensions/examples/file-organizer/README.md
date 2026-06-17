# file-organizer

A 100%-local, secure file-organization bundled extension. It proposes file
moves, renames, and garbage cleanup you accept or reject; auto-handles new
files in watched folders; recognizes junk/duplicate/stale clutter; lets you
co-design a workflow with an agent; and alerts you when a file falls outside
that workflow. **No network access** — nothing calls home.

## How it works

- **Watcher** = a host-side background daemon (`FileOrganizerDaemon`), not a
  cron job and not an in-sandbox watcher. It scans your watched folders on a
  fixed interval, proposes changes, and (in auto modes) applies them.
- **Accept / Reject** that move or delete real files run **host-side** in the
  EZCorp app — the extension's own sandbox can only touch its data directory,
  never your Desktop/Downloads.
- **Deletes are never hard.** "Delete" means move to a reversible quarantine
  under `.ezcorp/extension-data/file-organizer/.trash/`. Only the TTL / size-cap
  prune ever hard-deletes.
- **Three Hub pages**: Overview (status + alerts + pending count), Review
  (accept/reject + quarantine), Folders & Rules (watched folders, modes,
  presets, ignores).

## Modes

Set globally in **Settings** and per-folder on the **Folders & Rules** page.

| Mode | Moves / renames | Deletes |
|---|---|---|
| `ask-everything` (default) | wait for you | wait for you |
| `approve-non-destructive-only` | auto-applied | confirmed as one batch |
| `fully-auto` | auto-applied | silent → quarantine, with **Undo last auto-batch** |

The mode is read **at apply time**, never assumed — changing it takes effect
on the next action.

## Garbage presets

Toggle per-folder. See `knowledge/preset-rules.md` for the full list + the
quick-rule mini-DSL (`*.tmp older 7d -> quarantine`).

- **junk-sweep** — `*.tmp` (only ≥10 min old — see below), `*.bak`,
  `.DS_Store`, `Thumbs.db`, old `*.log`
- **downloads-router** — images → `Images/`, PDFs → `Documents/`, …
- **duplicate-killer** — content-identical files (by sha256)
- **stale-archiver** — files older than 90 days → `Archive/`

> **`.tmp` dwell guard.** The junk-sweep only quarantines a `*.tmp` once it
> is at least ~10 minutes old (`JUNK_TMP_MIN_AGE_MS`). Atomic-write libraries
> create a `*.tmp`, fsync it, then `rename()` it into place — a fresh `.tmp`
> is often a write-in-progress, not abandoned junk. The dwell guard (on top
> of the stability gate) keeps the sweep from racing those writers while
> still reclaiming genuinely-orphaned temp files. Browser/office partials
> (`.crdownload`/`.part`/`.partial`/`.download`/`~$…`) are excluded from
> scanning entirely.

## Exposing host folders to the container — the two-layer model

The EZCorp app runs at `/app` inside its container and can only see host paths
that are **bind-mounted** in compose. The Docker socket is deliberately NOT
exposed (host-root-equivalent), so a container cannot mount its own host
folders at runtime. "Add a folder to watch" is therefore two layers:

### Layer 1 — Mount (infra, one-time, restart required) → makes a folder *visible*

The prod compose only mounts `./.ezcorp/{data,extensions,extension-data}`; it
does NOT expose `~/Desktop` / `~/Downloads`. **Recommended convention: mount
ONE parent once** at a stable path via a gitignored, auto-merged override (no
edits to tracked compose files). `scripts/postinstall.ts` scaffolds a
commented `docker-compose.override.yml.example` for you:

```yaml
# docker-compose.override.yml
services:
  app:
    volumes:
      - ${EZCORP_WATCH_DIR:-~/}:/watched:rw   # :rw is REQUIRED — organizing moves/deletes
```

```sh
EZCORP_WATCH_DIR=~/  docker compose up -d --force-recreate
```

Then watch `/watched/Desktop`, `/watched/Downloads`, … — adding or removing
**subfolders** is pure UI, no restart. Only exposing a brand-new parent needs
an override edit + recreate.

> **uid-1000 permission note (prod):** the prod container runs as **uid 1000
> (`bun`)**. A mounted host folder must be readable+writable by uid 1000 or you
> get `EACCES`. (Dev runs as root, so this only bites in prod.) Quarantine
> lives under `.ezcorp/extension-data` (a different mount), so deletes are a
> cross-device copy+unlink — already handled.

### Layer 2 — Registration (app, dynamic, no restart) → tells the extension to *watch* a visible path

The **Folders & Rules** page writes `config.json`; the daemon picks it up on
its next tick. It can only reference paths Layer 1 made visible. The
**"Add watched folder"** prompt **exists-probes from inside the container** —
if the path isn't visible it returns *"That path isn't visible to the EZCorp
container — mount it under your watch root (or via
docker-compose.override.yml) and restart."* and watches nothing.

### Add / remove matrix

| Action | Where | Restart? |
|---|---|---|
| Watch a subfolder of a mounted root | Hub → Add | No |
| Stop watching / remove a folder | Hub → Remove (cancels pending; quarantine kept) | No |
| Expose a new host parent to the container | `docker-compose.override.yml` + `up -d --force-recreate` | Yes (once) |
| Fully revoke container access | Remove the mount from the override + restart | Yes |

## Settings

Flat per-user scalars (SchemaForm):

- **Enable background watcher** (`daemon_enabled`, default on)
- **Default mode** (`default_mode`, default ask-everything)
- **Quarantine retention (days)** (`quarantine_ttl_days`, default 30)
- **Quarantine size cap (GB, 0=off)** (`quarantine_cap_gb`, default 5)
- **Scan interval (s)** (`scan_interval_sec`, default 45)
- **Quiescent ticks before acting** (`stability_ticks`, default 2)

Per-folder rule lists live in `config.json` (authored via the Hub + the chat
agent), not in Settings.

## Safety invariants

No hard delete except prune · never overwrite (deterministic ` (2)` suffix) ·
realpath/lstat discipline · never write into `.ezcorp/data` · single atomic
writer + single daemon · idempotent + re-authorized apply · mode at apply
time · fail-closed on missing project root / unreachable folder / degraded
mount · every destructive action audited.
