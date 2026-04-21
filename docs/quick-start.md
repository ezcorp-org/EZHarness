# Quick Start (5 minutes)

Get EZCorp running locally with zero external dependencies beyond Docker.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose

## Setup

1. **Clone the repo:**

   ```bash
   git clone <repo-url> && cd ezcorp
   ```

2. **Start EZCorp:**

   ```bash
   docker compose up -d
   ```

3. **Open your browser:**

   Navigate to [http://localhost:3000](http://localhost:3000)

4. **Create your admin account** via the setup wizard.

5. **Start chatting.** Configure LLM providers under Settings > Provider Keys.

## Environment Variables

| Variable      | Default | Description       |
|---------------|---------|-------------------|
| `EZCORP_PORT` | `3000`  | Host port to bind |

Example: run on port 8080:

```bash
EZCORP_PORT=8080 docker compose up -d
```

## Data Persistence

Data is stored in a Docker volume named `ezcorp-data`. This volume persists across container restarts and rebuilds.

## Common Operations

**Stop EZCorp** (data preserved):

```bash
docker compose down
```

**Stop EZCorp and delete all data:**

```bash
docker compose down -v
```

**Update to latest version:**

```bash
git pull && docker compose up -d --build
```

**View logs:**

```bash
docker compose logs -f
```

## Configuring LLM Providers

After logging in, go to **Settings > Provider Keys** to add your API keys for:

- OpenAI
- Anthropic
- Google Gemini

EZCorp routes requests to the configured provider. At least one provider key is required for chat to work.

## Using Slash Commands

Reusable prompt templates are available in every chat via `/name`. Drop a
markdown file into any of these locations:

- `<project>/.claude/commands/` (Claude Code convention)
- `<project>/.codex/prompts/` (Codex CLI convention)
- `<project>/agents/`
- Or the same folders under your home directory (`~/.claude/commands/`, etc.)

Example `review.md`:

```markdown
---
description: Review staged changes
---
Review the following for bugs, style, and security: $ARGUMENTS
```

Then type `/review the auth middleware` in any chat. No restart needed —
new files appear in the popover within ~2 seconds.

See [slash-commands.md](slash-commands.md) for the full guide, including
argument substitution (`$ARGUMENTS`, `$1`, `$2`), frontmatter options,
and collision handling.
