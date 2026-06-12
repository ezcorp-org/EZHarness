# Quick Start

Two ways to run EZCorp, depending on what you want to do.

- **Self-host** (production / evaluation) — pre-built image from GHCR, embedded PGlite, no source checkout needed. Start here unless you're planning to hack on EZCorp itself.
- **From source** (development) — clone the repo, run with a live pgvector container via the dev Compose file.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2

## Self-host (recommended for most users)

```bash
# Fetch the production compose file
curl -O https://raw.githubusercontent.com/ezcorp-org/EZcorp/main/compose.prod.yml

# Generate persistent encryption secrets (must stay stable across restarts)
export EZCORP_ENCRYPTION_SECRET=$(openssl rand -base64 32)
export EZCORP_ENCRYPTION_SALT=$(openssl rand -base64 32)

docker compose -f compose.prod.yml up -d
```

Open [http://localhost:3000](http://localhost:3000), create your admin account, then go to **Settings > Provider Keys** to add an LLM provider key (OpenAI, Anthropic, Google Gemini, or any of the other 20+ supported providers).

### What you get

- Pre-built multi-arch image pulled from `ghcr.io/ezcorp-org/ezcorp:latest`
- Embedded PGlite on `/app/data/ezcorp` (no external database)
- Zero-setup web search: a SearXNG sidecar container backs the bundled `web-search` extension out of the box (keyless DuckDuckGo fallback when it's down) — no search API keys needed
- 30-minute interval backups + pre-boot snapshots under `/app/data/backups`
- `/api/ready` readiness probe (200 when ready, 503 while booting or after a failed migration)
- In-app update banner polling GitHub Releases once a day
- Optional Watchtower auto-update (commented out — enable in `compose.prod.yml`)

### Persistence

Data lives in `./.ezcorp/data/` in the working tree (`.ezcorp/` is gitignored), bind-mounted to `/app/data` in the container. It survives `docker compose down`, `down -v`, recreate, and image upgrades — nothing docker-managed to lose. One-time setup before the first `up`: `mkdir -p .ezcorp/data && sudo chown -R 1000:1000 .ezcorp/data`.

### Updates

**Manual:**

```bash
docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d
```

The safe boot sequence snapshots the DB before running migrations and rolls back if anything fails. See [production-guide.md §2](production-guide.md#2-boot-sequence-and-migration-safety).

**Automatic:** uncomment the `watchtower` block in `compose.prod.yml` to have new `:latest` images pulled and recreated every 24 hours.

### Production deployment

For HTTPS reverse proxy, external Postgres, security checklist, backup/restore procedures, and bind-mount ownership rules, see the **[production guide](production-guide.md)**.

## From source (development)

```bash
git clone https://github.com/ezcorp-org/EZcorp.git && cd EZcorp
docker compose up -d
```

This uses the dev `docker-compose.yml` — a different stack from self-hosted:

- External pgvector container (not embedded PGlite)
- Live source mounts for HMR
- Built from `Dockerfile.dev`, not the production `Dockerfile`
- No image labels, readiness gate, or update check

Use it for hacking; don't run it as a production instance.

## Environment variables (common)

| Variable                    | Default                       | Description                                                                    |
|-----------------------------|-------------------------------|--------------------------------------------------------------------------------|
| `EZCORP_PORT`               | `3000`                        | Host port to bind                                                              |
| `EZCORP_ENCRYPTION_SECRET`  | auto-gen on first boot        | Stored-credential encryption (set explicitly in prod)                          |
| `EZCORP_ENCRYPTION_SALT`    | auto-gen on first boot        | Key-derivation salt                                                            |
| `EZCORP_CHECK_UPDATES`      | `true`                        | Set `false` to hide the update banner and stop polling GitHub Releases         |
| `EZCORP_UPDATE_REPO`        | `ezcorp-org/EZcorp`           | Owner/repo for the update check                                                |
| `EZCORP_SCAN_GLOBAL_COMMANDS` | `1`                         | Set `0` for multi-tenant deploys — disables scanning `~/.claude/` etc. on the server |
| `SEARXNG_BASE_URL`          | `http://searxng:8080` (prod) / `http://localhost:8889` (dev) | Where the web-search extension finds the SearXNG sidecar             |
| `SEARXNG_SECRET`            | internal-only default         | SearXNG instance secret; set a real value only if you expose the sidecar      |

Full env var reference: [production-guide.md §1](production-guide.md#1-quick-start-embedded-pglite).

## Common operations

| Task                        | Command                                                                        |
|-----------------------------|--------------------------------------------------------------------------------|
| Stop (preserve data)        | `docker compose -f compose.prod.yml down`                                      |
| Stop + delete all data      | `docker compose -f compose.prod.yml down -v`                                   |
| Tail logs                   | `docker compose -f compose.prod.yml logs -f`                                   |
| Check readiness             | `curl http://localhost:3000/api/ready`                                         |
| Check current/latest version | `curl http://localhost:3000/api/version`                                      |
| Recover from failed migration | `docker exec <container> rm /app/data/.migration-failed && docker restart …` |

## Configuring LLM providers

After logging in, go to **Settings > Provider Keys** to add API keys. Providers supported out of the box include OpenAI, Anthropic, Google Gemini, and 20+ others via `@mariozechner/pi-ai`. At least one provider key is required for chat to work.

Long conversations are automatically compacted to each model's context window, so chats don't dead-end on `context_length_exceeded`. This is on by default and needs no configuration; to tune or disable it, see [context compaction](context-compaction.md).

## Using slash commands

Type `/review` (or any command name) in any chat. Commands come from:

- `<project>/.claude/commands/` (Claude Code convention)
- `<project>/.codex/prompts/` (Codex CLI convention)
- `<project>/agents/`
- The same folders under your home directory (`~/.claude/commands/`, etc.)

Example `review.md`:

```markdown
---
description: Review staged changes
---
Review the following for bugs, style, and security: $ARGUMENTS
```

New files appear in the popover within ~2 seconds — no restart needed. Full guide: [slash-commands.md](slash-commands.md).
