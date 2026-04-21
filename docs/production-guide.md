# Production Deployment

Deploy EZCorp with an external Postgres database and HTTPS reverse proxy.

## Prerequisites

- Docker with Docker Compose
- PostgreSQL 15+ with the [pgvector](https://github.com/pgvector/pgvector) extension
- Reverse proxy (Caddy, nginx, or similar) for HTTPS termination

## 1. Database Setup

Create a database and enable pgvector:

```sql
CREATE DATABASE ezcorp;
\c ezcorp
CREATE EXTENSION vector;
```

## 2. Environment Variables

Create a `.env` file (or export these variables):

| Variable                        | Required | Description                                                                                                    |
|---------------------------------|----------|----------------------------------------------------------------------------------------------------------------|
| `DATABASE_URL`                  | Yes      | Postgres connection string                                                                                     |
| `EZCORP_JWT_SECRET`             | No       | JWT signing secret (auto-generated if not set)                                                                 |
| `EZCORP_PORT`                   | No       | Host port (default: 3000)                                                                                      |
| `EZCORP_SCAN_GLOBAL_COMMANDS`   | No       | Set to `0` to disable slash-command discovery from `~/.claude/`, `~/.codex/`, `~/agents/` on the server. **Recommended off (`0`) for multi-tenant deployments** — the server's home directory is shared across all users. Default: `1`. |

Example `.env`:

```env
DATABASE_URL=postgresql://ezcorp:secretpassword@db.example.com:5432/ezcorp
EZCORP_JWT_SECRET=change-me-to-a-random-string
```

## 3. Start EZCorp

```bash
docker compose -f compose.prod.yml up -d
```

## 4. Reverse Proxy

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

WebSocket headers (`Upgrade`, `Connection`) are required for streaming chat responses.

## 5. Backups

EZCorp includes a built-in backup system (30-minute interval, 5-backup retention) for PGlite mode. For external Postgres, use standard tools:

```bash
pg_dump -U ezcorp ezcorp > ezcorp_backup_$(date +%Y%m%d).sql
```

## 6. Updating

```bash
git pull
docker compose -f compose.prod.yml up -d --build
```

Migrations run automatically on startup.

## 7. Security Checklist

- [ ] Set a strong `EZCORP_JWT_SECRET` (changing it invalidates all sessions)
- [ ] Use HTTPS in production (required for secure cookies)
- [ ] Restrict database access with firewall rules
- [ ] Keep Docker and Postgres updated
- [ ] Review LLM provider API key permissions
- [ ] Set `EZCORP_SCAN_GLOBAL_COMMANDS=0` for multi-tenant deployments — the server's home-directory slash-command scan is shared across every authenticated user, so anyone with host write access could inject prompt templates into all users' chats. See [slash-commands.md](slash-commands.md#multi-tenant-deployments).

## Known Limitations

- External Postgres support requires `src/db/connection.ts` to conditionally use the pg driver instead of PGlite. PGlite is the current default; external Postgres via `DATABASE_URL` is a planned enhancement.
- The `compose.prod.yml` file defines the configuration surface for when external Postgres support is fully wired.
