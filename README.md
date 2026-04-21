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

## Quick Start

```bash
git clone <repo-url> && cd ezcorp
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000), create your admin account, and start chatting.

## Docker Setup

EZCorp runs as a single Docker service with PGlite (embedded Postgres) by default.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EZCORP_PORT` | `3000` | Host port to bind |
| `EZCORP_DB_PATH` | `/app/data/ezcorp` | Database storage path |
| `EZCORP_SCAN_GLOBAL_COMMANDS` | `1` | Scan `~/.claude/`, `~/.codex/`, `~/agents/` for slash commands. Set to `0` for multi-tenant deploys. |

### Custom Port

```bash
EZCORP_PORT=8080 docker compose up -d
```

### Data Persistence

Data is stored in a Docker volume named `ezcorp-data`. This volume persists across container restarts and rebuilds.

### Volume Migration

If migrating from a previous installation using `pi-data`:

```bash
docker volume create ezcorp-data && docker run --rm -v pi-data:/from -v ezcorp-data:/to alpine cp -a /from/. /to/
```

### Production Deployment

For external Postgres and HTTPS, see [docs/production-guide.md](docs/production-guide.md).

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
