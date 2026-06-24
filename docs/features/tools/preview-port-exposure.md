# Preview / Port Exposure

> _Safely exposes a dev server that an agent's shell command starts inside the container to the requesting user **only** — via structural isolation (a per-conversation OS boundary), a one-time consent step, and a separate-origin reverse proxy gated by a short-lived signed token._

## Intent

When the LLM runs a long-running dev server (`bun dev`, `vite`, `next dev`, …) through the `shell` tool, the user usually wants to see it in a browser. Naively exposing a container-internal port is dangerous: it could leak one user's site to another, or let untrusted user code reach the app's DB and JWT secret. This feature makes "show me the running site" safe **by construction** rather than by LLM cooperation: the dev server runs under a dedicated isolation boundary (a preview **uid**, or a network namespace where available), its listen port is auto-detected and attributed back to exactly one conversation/user, the user must explicitly consent before anything serves, and traffic flows through a hardened reverse proxy on a wildcard `*.preview.<host>` origin behind a per-preview, per-user signed token.

## How it works

### 1. Capability tiering (fail-closed)

`previewCapabilities()` (`src/runtime/preview/preview-netns.ts`) picks one mode at boot, in precedence order:

- **`netns`** — the hardened tier: a per-conversation network namespace (veth into `br-ezcorp-mcp`, `10.42.0.0/24`, with nftables ingress rules from `buildIngressAllowRule`). Requires user/mount-namespace + `CAP_NET_ADMIN`. **Unavailable on standard Docker on this host**, so it is effectively not active in current deployments.
- **`uid`** — the portable tier (the live default here): each conversation that runs a dev server gets a dedicated uid from the allowlisted range **90000–99000** (`preview-uid-pool.ts`). The uid is both the **fs-isolation** boundary (it cannot read `.ezcorp/data`, which is locked to 0700 app-uid-owned) and the **attribution** key (`/proc/net/tcp` exposes a uid column). Requires the setuid-root spawn helper.
- **`static`** — fail-closed: no dynamic previews; static-file previews still serve.

`netns` falls through to `uid` if veth/CAP_NET_ADMIN is missing; `uid` falls through to `static` if the setuid helper is absent. No silent degradation — the chosen reason is logged.

### 2. Detecting a dev-server launch in the shell tool

The `shell` tool (`src/runtime/tools/shell.ts`) is wired with an optional `ShellPreviewWiring` (threaded from `src/runtime/stream-chat/setup-tools.ts`, only when the conversation has an owning `userId`). Before the normal `Bun.spawn` path:

1. `detectDevServerCommand(command)` (`dev-command-detection.ts`) classifies the command string with a **pure, conservative allowlist** — package-manager scripts (`<pm> [run] dev|start|serve|preview`) and direct binaries (`vite`, `next dev`, `astro dev`, …), behind optional `npx`/`bunx`/`pnpm dlx` runners and `FOO=bar` env prefixes. It **bails on any shell metacharacter** (`| & ; < > \` $(...) ${...}`) — a compound command can't be safely run through the single-exec helper. When unsure it returns `null` and the shell runs the command exactly as before (fail-safe).
2. On a match, `preview.launch(...)` → `launchPreviewDevServer` (`preview-spawn-orchestration.ts`): capability-gate to `uid` mode, allocate (or reuse) the conversation's preview uid, **register the conversation with the port watcher before spawning**, then spawn the dev server through the setuid helper (`spawnPreviewServer` → `/app/bin/preview-spawn`, which does setgid/setuid/setgroups/chdir/clearenv before `execvp`). The launched process is long-lived and supervised; the tool returns immediately ("a preview link will appear once it starts listening").
3. Any refusal (`{ok:false}` — static mode, pool exhausted, missing helper, spawn failure) falls through to the normal shell execution path. A refusal is never a hard failure.

### 3. Auto-detecting the listen port (requester-scoped)

`PreviewPortWatcher` (`preview-port-watcher.ts`) is a background daemon (PID lockfile, interval ticks, swallowed errors) wired in `src/startup/background-timers.ts`. It polls an injected `PreviewPortSource` per watched conversation:

- `caps.mode === "uid"` → `ProcPortSource` (reads `/proc/net/tcp{,6}`, maps a LISTEN socket's uid column back to a conversation via `conversationForPreviewUid`).
- otherwise → `NetnsPortSource` (hardened; yields nothing on a fail-closed host → the watcher is a logged no-op).

Detection rules: a port must stay LISTENing for `stabilizeTicks` (default 2) consecutive ticks (debounce restart flapping), dedups per `(conversationId, port)` until the port fully disappears (a restart re-arms), and filters infra ports (`22`, `53`, `0`, plus any caller-supplied set). On a stable, new, non-infra port it fires `onDetected` with `{ userId, conversationId, port }` — **always requester-scoped**, never broadcast. It can also **idle-reap** a conversation that bound then lost its port for `idleReapTicks` (`EZCORP_PREVIEW_IDLE_REAP_TICKS`).

### 4. Consent → expose

`onDetected` routes through `onPreviewDetected` → `decideOnDetection` (`preview-consent.ts`):

- If the conversation has the per-conversation **"always expose"** preference set for *this* user (stored in the `settings` table under `preview:always-expose:<conversationId>`, with the owning userId recorded so a re-owned conversation can't inherit it) → **auto-expose**: `exposeDetectedPort` creates a `dynamic` `preview_sessions` row + mints a one-time code; no prompt.
- Otherwise → a **consent card** (`cardType: "ez-preview-consent"`) is pushed onto the originating conversation's live SSE stream by `preview-detection-bridge.ts` (as a `tool:complete` event, the same carrier `propose`/`ask_user` cards ride, so `shouldDeliverEvent` delivers it to **only** that user's tab). The card offers **[Expose] [Ignore] [Always expose in this conversation]**. **Nothing serves until the user clicks Expose** — auto-detect ≠ auto-serve.

The card's actions POST to `/api/preview/consent`. The acting user is the authenticated session user (attribution by construction — a `userId` in the body is never trusted). `exposeDetectedPort` is the single expose path used by both the explicit click and the always-expose branch.

### 5. Serving on a separate origin (the proxy)

Routing is by **wildcard subdomain `<id>.preview.<appHost>`** (LOCKED decision D4) — a true separate origin, so the app's host-only `ezcorp_session` cookie is never sent there. `hooks.server.ts` calls `matchPreviewOrigin` **first** (before payload/rate/auth) → `servePreviewRequest` (`web/src/lib/server/preview/dispatch.ts`):

- **Host parse / DNS-rebind defense** (`parsePreviewHost`): the Host must be exactly `<label>.preview.<appHost>` with `<label>` a well-formed 26-char Crockford-base32 preview id (`isValidPreviewId`) — rejected before any DB hit. `appHost` comes from `EZCORP_PREVIEW_APP_HOST`; **unset ⇒ the preview origin is fully disabled** (parse returns null for every host).
- **Token handoff** (`/__open?c=<code>`): the browser redeems a one-time code (`redeemOneTimeCode`, single-use, ~60s TTL), the proxy mints the `__ezpreview` JWT (`signPreviewToken`, ~15min TTL, same instance secret as the session JWT) and sets it **host-only** (no `Domain=`) on the subdomain, then 302s to `/`.
- **Every other request** → `handlePreviewRequest` (`preview-proxy.ts`): verify the `__ezpreview` cookie, assert `claims.previewId === previewId`, look up `getServablePreview(id, userId)` (owned + active + unexpired + unrevoked), then:
  - **static** branch: `resolveStaticFile` with realpath/traversal/symlink-escape guards under `.ezcorp/sites/<id>/`, streamed via `Bun.file`.
  - **dynamic** branch: per-preview **rate check** (429 over cap) → `proxyDynamicFetch` pins the upstream to **exactly `127.0.0.1:<targetPort>`** with `redirect:"manual"` (no SSRF off the pinned port), strips inbound credential/forwarding headers (`sanitizeInboundHeaders`), sanitizes the upstream response (`sanitizeUpstreamResponse` — strips hop-by-hop + `X-Frame-Options`, **neutralizes `Set-Cookie` Domain=** to prevent cookie-tossing onto the app/sibling origins), and **meters response bytes** against a rolling per-preview budget. A dead upstream → graceful 502.
- **WebSocket / HMR** upgrades are bridged first (`ws-bridge.ts`), with a CSWSH `Origin` check (`isAllowedPreviewOrigin`, `preview-ws.ts`) and the same loopback port-pin.

### 6. Reaping

`reapPreviewConversation` (`preview-reaper.ts`) tears a conversation down (on conversation delete, idle-reap, or explicit stop), in order: **kill the dev-server processes first** (through the setuid helper's `--kill` group-kill — the app uid can't `kill(2)` a preview-uid process, EPERM), **revoke** the `preview_sessions` rows (proxy fails closed instantly), **release OR quarantine** the uid (quarantine when the kill could not be confirmed — a possible live orphan must never share its uid with a future conversation), release any netns, drop the watcher's watch, and forget the rate-limit accounting. `DELETE /api/conversations/[id]` calls this before the FK cascade.

## Usage

### API routes

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/preview/consent` | `requireAuth` (session) | Consent-card actions. Body `{ conversationId, port?, action }`; `action ∈ expose \| always-expose \| ignore \| disable-always`. `expose`/`always-expose` → `{ ok, previewId, code, subdomainLabel }`. |
| `POST /api/preview/[id]/token` | `requireAuth` (session) | App-origin handoff mint: returns a fresh one-time `{ code }` for an owned, live preview (else opaque 404). Used to (re-)mint the `/__open` handoff. |
| `GET … /__open?c=<code>` | preview origin (no app session) | Served by the proxy dispatch on `<id>.preview.<host>`: redeems the one-time code → sets the host-only `__ezpreview` cookie → 302 `/`. |
| `* … <id>.preview.<host>/*` | `__ezpreview` cookie | The reverse proxy itself (static files or dynamic passthrough), matched in `hooks.server.ts` before app routing. |

> Note: the two app-origin routes use **`requireAuth` only** (no `requireScope`) — they are session-gated and attribute strictly to the session user.

### UI entry point

- The **expose-consent card** (`cardType: "ez-preview-consent"`) renders inline in the conversation when a dev server is detected. Its parse/build logic is `web/src/lib/components/tool-cards/preview-consent-card-logic.ts` (the card component owns the POST to `/api/preview/consent` and opens the `/__open` URL via `buildOpenUrl`).

### Environment variables

| Var | Effect |
|---|---|
| `EZCORP_PREVIEW_APP_HOST` | Bare app host owning `*.preview.<host>` (e.g. `localhost`, `ezcorp.example.com`). **Unset ⇒ preview origin disabled.** |
| `EZCORP_PREVIEW_SPAWN_HELPER` | Override path to the setuid helper (default `/app/bin/preview-spawn`). |
| `EZCORP_DISABLE_PREVIEW_WATCHER=1` | Kill switch for the port-watcher daemon. |
| `EZCORP_PREVIEW_WATCHER_POLL_MS` | Watcher poll cadence (default 2000ms, floor 250ms). |
| `EZCORP_PREVIEW_IDLE_REAP_TICKS` | Consecutive zero-listener ticks before idle-reaping a conversation (0 = disabled). |
| `EZCORP_PROJECT_ROOT` | Derives `.ezcorp/data` (lockdown target) and `.ezcorp/sites/` (static root). |
| `FORCE_SECURE_COOKIES=true` | Adds `Secure` to the `__ezpreview` cookie. |

## Key files

- `src/runtime/preview/dev-command-detection.ts` — pure dev-server command classifier (allowlist + tokenizer; bails on shell metacharacters).
- `src/runtime/tools/shell.ts` — `shell` tool; `ShellPreviewWiring` spawn trigger + the per-run sandbox jail wiring.
- `src/runtime/preview/preview-spawn-orchestration.ts` — `launchPreviewDevServer` (alloc uid → register watcher → spawn) + `killConversationProcesses` (confirmed/unconfirmed kill accounting).
- `src/runtime/preview/preview-spawn.ts` — setuid-helper driver: uid-range allowlist (90000–99000), argv builders, `isPreviewSpawnHelperPresent`, `killPreviewProcess`.
- `src/runtime/preview/preview-uid-pool.ts` — per-conversation uid alloc/reap/**quarantine** + the `.ezcorp/data` 0700 app-uid-owned **lockdown keystone** (`enforceDataDirLockdown`).
- `src/runtime/preview/preview-netns.ts` — `previewCapabilities()` tiering + per-conversation netns scaffolding + `buildIngressAllowRule`.
- `src/runtime/preview/preview-port-watcher.ts` — `PreviewPortWatcher` daemon (stabilize/dedup/infra-filter/idle-reap; emits `preview:detected`).
- `src/runtime/preview/preview-port-source.ts` — `ProcPortSource` (/proc/net/tcp, uid attribution) + `NetnsPortSource` (hardened, fail-closed).
- `src/runtime/preview/preview-consent.ts` — `decideOnDetection`, `exposeDetectedPort`, the per-conversation "always expose" preference, consent-card payload.
- `src/runtime/preview/preview-detection-bridge.ts` — push a decision onto the conversation SSE stream as an `ez-preview-consent` `tool:complete`; `buildPreviewOpenUrl`.
- `src/runtime/preview/preview-token.ts` — one-time-code store (in-process) + `__ezpreview` JWT sign/verify.
- `src/runtime/preview/preview-proxy.ts` — pure proxy: `parsePreviewHost`, `resolveStaticFile`, header sanitation, `Set-Cookie` neutralization, `handlePreviewRequest` (static + dynamic branches).
- `src/runtime/preview/preview-rate-limit.ts` — per-preview request-rate token bucket + rolling byte budget.
- `src/runtime/preview/preview-reaper.ts` — `reapPreviewConversation` (kill → revoke → release/quarantine uid → unwatch → forget quota).
- `src/runtime/preview/preview-ws.ts` — CSWSH `Origin` validation + WS-upgrade detection.
- `web/src/lib/server/preview/dispatch.ts` — SvelteKit glue: `matchPreviewOrigin`, `servePreviewRequest`, `/__open` cookie swap, `proxyDynamicFetch`, byte metering.
- `web/src/lib/server/preview/ws-bridge.ts` — `tryBridgePreviewWebSocket` + `createPreviewWebSocketHandler` (HMR bridge, loopback-pinned).
- `web/src/routes/api/preview/consent/+server.ts` — `POST` consent actions (expose / always-expose / ignore / disable-always).
- `web/src/routes/api/preview/[id]/token/+server.ts` — `POST` one-time-code mint for an owned live preview.
- `web/src/lib/components/tool-cards/preview-consent-card-logic.ts` — pure consent-card parse/build + `buildOpenUrl`.
- `src/db/queries/preview-sessions.ts` — `createPreviewSession`, `getServablePreview`, `touchPreview`, `revokePreview`, `reapPreviewIdsForConversation`, id minting (`generatePreviewId`/`isValidPreviewId`), `assertUnderSitesRoot`.
- `src/db/schema.ts` — `preview_sessions` table (`kind`, `targetPort`, `staticPath`, `netnsId`, `status`, `expiresAt`, `lastSeenAt`, `revokedAt`; FKs SET NULL).
- `src/startup/background-timers.ts` — boots the watcher, selects the source by capability mode, wires `onPreviewDetected` + idle-reap; exposes `getPreviewPortWatcher()`.
- `web/src/hooks.server.ts` — preview-origin dispatch entry (runs before payload/rate/auth).
- `build/preview-spawn.c` — the setuid-root helper (privilege drop + `--kill` group-kill); installed 4755 by the Dockerfile.

## Features it touches

- [[builtin-file-tools]] — the `shell` tool is the trigger; a recognized dev-server command is rerouted under a preview uid instead of the normal spawn.
- [[conversations]] — previews are conversation-scoped; `DELETE /api/conversations/[id]` reaps the conversation's preview process + uid before the cascade.
- [[streaming-runtime]] — the consent card is delivered as a `tool:complete` event over the conversation's live SSE stream.
- [[sandbox-and-isolation]] — the preview uid + the `.ezcorp/data` 0700 lockdown are the structural isolation boundary; the same shell tool also carries a per-run jail (`ShellSandboxWiring`).
- [[permissions-and-grants]] — exposure is an explicit per-detection user consent, not an LLM-controlled action.
- [[runtime-and-rpc]] — `src/runtime/stream-chat/setup-tools.ts` threads the preview wiring into the builtin tool set for an owned conversation.
- [[authentication]] — the `__ezpreview` token reuses the instance JWT secret; the separate origin deliberately excludes the session cookie.
- [[api-security]] — the proxy enforces its own token + registry access on a separate origin; DNS-rebind, SSRF, CSWSH, and cookie-tossing defenses live in the proxy/ws layers.
- [[scheduling-and-loops]] — the port watcher + idle reaper run as background daemons alongside the other background timers.

## Related docs

None yet — this is the primary reference. The full spec / locked decisions live in `tasks/preview-port-exposure.md` (referenced throughout the source as "§3.x" / "D2"–"D4" / "Phase 3 REDESIGN"). The source comments also point operators at `docs/preview-hosting.md` for wildcard-DNS / TLS setup, but that doc has not been written yet (the path is a forward reference, not an existing file).

## Notes & gotchas

- **netns mode is effectively dormant here.** Standard Docker on this host lacks the namespaces + `CAP_NET_ADMIN`, so `previewCapabilities()` resolves to `uid`. The netns alloc/nftables/veth code is fully built and tested but the live passthrough was Phase-3 wiring; the `uid` tier is the real path in current deployments. `static` is the fail-closed floor.
- **Preview origin is OFF unless `EZCORP_PREVIEW_APP_HOST` is set.** `parsePreviewHost` returns null for every host when it's unset, so a misconfigured deploy never accidentally serves untrusted content on an unexpected origin. It needs wildcard DNS + (in prod) a wildcard TLS cert for `*.preview.<host>`.
- **The `.ezcorp/data` 0700 lockdown is load-bearing and fail-closed.** `enforceDataDirLockdown()` must run at boot and assert the dir is 0700 **and** app-uid-owned (create-and-lock if absent, so a later PGlite create can't leave it 0755). If it can't be enforced, the caller must refuse uid-mode dynamic previews — otherwise a preview uid could read the DB + encrypted JWT secret.
- **uid quarantine on unconfirmed kill.** If the reaper can't confirm a dev-server tree is dead (helper non-zero, missing captured uid/pgid, thrown killer), the uid is **quarantined**, not returned to the pool — a future conversation must never inherit a uid a live orphan still owns. Quarantined uids are reclaimed only out-of-band (process exit / container teardown).
- **Cross-uid kill needs the setuid helper.** The reaper runs as the app uid (1000); a direct `proc.kill()` against a preview-uid (90000+) process is EPERM and silently swallowed. All real kills route through `build/preview-spawn.c`'s `--kill` (group-kill by pgid; the helper `setsid()`s so `pgid === pid`).
- **The detector is conservative and bails on shell operators.** Any `|`, `&`, `;`, `<`, `>`, backtick, `$(...)`, or `${...}` makes `detectDevServerCommand` return null → the command runs through the normal shell path, **not** under a preview uid. So `cd app && bun dev` is not detected; only a single simple dev-server invocation is.
- **One-time-code + cookie stores are in-process.** Both `preview-token.ts`'s code store and the rate-limit quota singleton are module-scoped Maps — correct for the single-shared-container deploy, but a multi-instance deploy would need a shared store behind the same interface.
- **Static-path containment is realpath-based.** `assertUnderSitesRoot` (at registration) and `resolveStaticFile` (at serve time) both realpath against `.ezcorp/sites/` to catch symlink escapes — stronger than the **lexical** path check the built-in file tools (`validatePath`) use; don't assume the file-tool guard would catch a symlink escape here.
- **Helper binary must live outside the source tree.** The compiled `preview-spawn` ELF must NOT sit at `src/runtime/preview/preview-spawn` (no extension) or Bun resolves the extensionless `./preview-spawn` import to the binary and crashes boot; it's pinned to `/app/bin/`. (Host worktrees have no binary, so this is image-only.)
- **Not the same as `EZCORP_PREVIEW_JAIL`.** That env (`src/extensions/preview-jail.ts`) is the extension-sandbox jail, unrelated to this dev-server preview feature.
