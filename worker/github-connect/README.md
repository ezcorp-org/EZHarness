# Public GitHub App directory

This Cloudflare Worker publishes only public GitHub App details. The self-hosted EZCorp backend talks directly to GitHub for device authorization, token refresh, repository import, and pull request publication. This Worker is outside those paths.

## GitHub App setup

Use App ID `5049328`, client ID `Iv23linp84AzzvCGxstF`, and the verified GitHub App slug `ezcorp-github-auth`. The public App page is <https://github.com/apps/ezcorp-github-auth>. Missing or malformed bindings make every route return `503 Service Unavailable`.

In GitHub App settings, enable Device Flow and expiring user tokens. Leave the Setup URL and callback URL blank. Disable “Request user authorization (OAuth) during installation” and deselect “Active” under Webhook. A Setup URL would receive GitHub's `installation_id` query value; this public directory must not receive it. Do not set this Worker as a callback, webhook, or proxy.

## Local checks

From this directory, use the repository's pinned Bun:

```sh
bun install --frozen-lockfile
bun run types:check
bun run build
bun run dev
```

For a local HTTP smoke test, `bun run dev` uses the public `production` bindings. Request `/`, `/style.css`, `/.well-known/ezcorp-github.json`, and `/health`. Use `bun run dev -- --var APP_SLUG:` to verify that missing configuration returns 503. GET and HEAD are the only accepted methods; query strings and credential headers return 400; all other methods return 405. No request body is read.

`bun run types` regenerates `worker-configuration.d.ts` from Wrangler config. This package has its own lockfile. `bun run build` creates a dry-run bundle under ignored `dist/`; it does not deploy. Only the named `production` environment has public App bindings and the custom domain `github-auth.ezcorp.org`; `workers.dev` and preview URLs are off. A future approved deployment must target `--env production`, after verifying that the Cloudflare account controls the domain.

## Data handling

The Worker has no storage bindings, analytics binding, application request logging, cookies, token exchange, or upstream requests. Its stylesheet is static and served from the same Worker; it loads no fonts, images, or scripts. Wrangler explicitly sets `observability.enabled`, logs, traces, Logpush, and CLI telemetry to false. Local `wrangler dev` can still emit local diagnostic output; use `--log-level error` during a smoke test. The Worker sends `Cache-Control: no-store`, a restrictive CSP, and other browser security headers. It never echoes submitted input. These settings describe application behavior. Cloudflare may still process network and account metadata under its platform policies; the operator must review those policies and account-level settings separately.
