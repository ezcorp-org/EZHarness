# EZCorp

Chat with persistent memory, find agent apps others built, and create your own.

EZCorp is a self-hosted AI platform that brings together multi-model chat, long-term memory, and an extension ecosystem in one product.

## Pillars
- Extensibility
  - extension that allow users to create custom UI, and interactions 
- Security 
  - Role Based Access Control
  - permissions for LLM tool calls
- Reliability

## Features

- **Multi-model streaming chat** -- Connect OpenAI, Anthropic, Google Gemini, and 20+ providers. Switch models mid-conversation.
- **Persistent memory** -- Conversations are remembered across sessions with semantic search and automatic context injection.
- **Extensions and marketplace** -- Install community extensions or build your own tools, skills, and agents.
- **Slash commands** -- Type `/review`, `/commit`, `/deploy` to expand reusable prompt templates. Compatible with Claude Code (`.claude/commands/`), Codex CLI (`.codex/prompts/`), and plain `agents/` folders. See [docs/slash-commands.md](docs/slash-commands.md).
- **Teams** -- Multi-user support with team workspaces and shared conversations.
- **Self-hosted** -- Your data stays on your infrastructure. Runs on a single Docker container with zero external dependencies.

## Quick Start (self-hosted, pre-built image)

```bash
curl -O https://raw.githubusercontent.com/ezcorp-org/EZcorp/main/compose.prod.yml
curl -O https://raw.githubusercontent.com/ezcorp-org/EZcorp/main/.env.prod.example
cp .env.prod.example .env.prod && chmod 600 .env.prod
# fill the three secrets in .env.prod with: openssl rand -base64 32 (and -base64 16 for the salt)
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

Open [http://localhost:4000](http://localhost:4000), create your admin account, and start chatting. Your data lives in a named Docker volume and survives `docker compose down`.

For HTTPS, backups, external Postgres, and auto-updates, see the **[production guide](docs/production-guide.md)**.

## Quick Start (from source)

```bash
git clone <repo-url> && cd ezcorp
docker compose up -d                               # → http://localhost:3000 (dev / Vite HMR)
```

For a production-mode build from the same checkout:

```bash
docker build -t ezcorp:local .
cp .env.prod.example .env.prod && chmod 600 .env.prod
echo "EZCORP_IMAGE=ezcorp:local" >> .env.prod      # pin to your local build
# fill in the three secrets in .env.prod
docker compose -f compose.prod.yml --env-file .env.prod up -d   # → http://localhost:4000
```

### Dev and prod side-by-side

`docker-compose.yml` (dev) and `compose.prod.yml` (prod) declare distinct project names (`ez-corp-ai` and `ezcorp-prod`) and bind to different host ports (`3000` and `4000` by default), so the two stacks run independently — same source tree, different runtimes, different volumes. Bringing one up never touches the other:

```bash
docker compose up -d                                              # dev
docker compose -f compose.prod.yml --env-file .env.prod up -d     # prod
docker compose -f compose.prod.yml --env-file .env.prod down      # stop prod, dev keeps running
```

Without the distinct `name:` they would share the default project namespace (the directory name) and `up` against either file would silently recreate the other's container in place.

## Docker Setup

EZCorp runs as a single Docker service with PGlite (embedded Postgres) by default. A safe boot sequence (pre-migrate snapshot → migrate → rollback-on-failure) protects your data across upgrades. See [Boot sequence and migration safety](docs/production-guide.md#2-boot-sequence-and-migration-safety) for details.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `EZCORP_PORT` | `3000` | Host port to bind |
| `EZCORP_DB_PATH` | `/app/data/ezcorp` | Database storage path |
| `EZCORP_BACKUP_DIR` | `<dbDir>/backups` | Where pre-boot and interval snapshots live |
| `EZCORP_CHECK_UPDATES` | `true` | In-app update banner (set `false` to disable the GitHub Releases poll) |
| `EZCORP_UPDATE_REPO` | `ezcorp-org/EZcorp` | Owner/repo for the update check |
| `EZCORP_SCAN_GLOBAL_COMMANDS` | `1` | Scan `~/.claude/`, `~/.codex/`, `~/agents/` for slash commands. Set to `0` for multi-tenant deploys. |

### Readiness probe

- `GET /api/health` — liveness (HTTP is up). Used by Docker's `HEALTHCHECK`.
- `GET /api/ready` — readiness (migrations succeeded). 503 during boot or if a migration failed. Point Watchtower / Kubernetes / load-balancer probes here.

### Auto-updates

The in-app banner notifies you when a new release is published. For fully
automatic updates, uncomment the Watchtower service in `compose.prod.yml` —
it'll pull new `:latest` images and the safe boot sequence handles migration
rollback if anything goes wrong.

### Data persistence

Data is stored in the `ezcorp-data` named volume. It survives container
restarts and image upgrades; only `docker compose down -v` destroys it.

### Volume migration

If migrating from a previous installation using `pi-data`:

```bash
docker volume create ezcorp-data && docker run --rm -v pi-data:/from -v ezcorp-data:/to alpine cp -a /from/. /to/
```

### Production deployment

For external Postgres, TLS reverse-proxy config, auto-updates, and backup/restore procedures, see [docs/production-guide.md](docs/production-guide.md).

## Building Extensions

EZCorp supports tools, skills, agents, and MCP servers as extensions.

```bash
ezcorp ext init my-tool --type tool
```

See [docs/extensions/](docs/extensions/) for the full extension development guide.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please ensure tests pass before submitting:

```bash
bun test
```
