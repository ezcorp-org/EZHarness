# Onboarding & Quickstart

> _The first-run path of EZCorp: a zero-user install bootstraps its first admin at `/setup`, a per-user three-step welcome wizard at `/onboarding` (gated by a `onboarded_at` stamp), and a dismissable "Get Started" checklist that polls `/api/quickstart` for setup progress._

## Intent

A freshly deployed EZCorp instance has no users, no provider keys, and no chats. This feature carries a new operator from "container is up" to "I'm chatting": it forces the very first request on an empty install to `/setup` (create the admin), walks each freshly-created user through a short welcome wizard the first time they sign in, and surfaces a lightweight progress checklist that nudges them through the four "first useful actions" (add a provider, start a chat, install an extension, create an agent). All three are independent layers — instance-level setup, per-user onboarding, and the persistent checklist — that key off different signals (`users` count, `users.onboarded_at`, and live counts across `settings`/`conversations`/`extensions`/`agentConfigs`).

## How it works

There are three distinct gates, evaluated in this order across a user's lifecycle:

### 1. First-run setup (instance-level, user count == 0)

- `web/src/hooks.server.ts`'s `handle` is the choke point. For a non-public, unauthenticated request it calls `getUserCount()` (`src/db/queries/users.ts`). That query **excludes synthetic `sys-*` users** (seeded by extensions like `ai-kit` for internal/OBO auth) so a booted-with-extensions instance still reads as "no human admin yet".
- `count === 0` → API paths get `401 {"error":"Setup required"}`; page navigations `throw redirect(302, "/setup")`.
- `/setup` and `/api/auth/setup` are in `PUBLIC_PATHS`, so they're reachable while logged-out. The page's `load` (`(auth)/setup/+page.server.ts`) re-checks `getUserCount()` and bounces to `/login` if someone already set up.
- `POST /api/auth/setup` is the bootstrap: rate-limited (3 attempts / hour / IP, fired **before** the count read so an attacker can't pin the DB in read loops), re-asserts `getUserCount() === 0` (else `403 "Setup already completed"`), validates `{name,email,password}` (`setupSchema`, with the shared `passwordSchema`), then `createUser({ role: "admin" })`, mints a JWT, writes `instance:initialized=true`, records a `user:registered` audit entry, **creates a session row** (so the revocation check in `hooks` accepts the cookie on the next nav — without it the new admin would bounce to `/login`), and sets the session cookie. Returns `201` with the user.

### 2. Per-user onboarding wizard (`users.onboarded_at IS NULL`)

- After auth resolves in `handle`, a **pages-only** gate runs (API + `/_app/` asset paths bypass entirely, so programmatic clients are never redirected). It `getUserById(user.id)`, stashes `onboardedAt` on `event.locals` (so the wizard's `load` doesn't re-query), and if `onboardedAt === null` and the path isn't already `/onboarding`, `throw redirect(302, "/onboarding")`.
- `(auth)/onboarding/+page.server.ts` loads `{ user, hasProvider }` (`hasAnyProvider()` from the quickstart query) and redirects to `/` if `locals.onboardedAt` is already set (defensive double-stamp guard).
- The wizard (`(auth)/onboarding/+page.svelte`) is three steps: **(1)** connect a provider (embeds `ProviderSettings`; Continue is disabled until a key/OAuth is present, "Skip for now" advances anyway), **(2)** pick a default tier (`quality`/`balanced`/`budget`, persisted to `provider:defaultTier` only if the user actually touched a radio), **(3)** a mention-sigil primer (`@`/`!`/`/`). The final "Get started" button `POST`s `/api/onboarding/complete`, then does a **full `window.location.href = "/"` reload** (not `goto`) so `hooks` re-reads the fresh stamp and skips the gate cleanly.
- `POST /api/onboarding/complete` calls `markUserOnboarded(user.id)` and returns `204`. The update is **first-write-wins**: `SET onboarded_at = NOW() WHERE id = ? AND onboarded_at IS NULL`. The `IS NULL` predicate makes a re-POST race (two tabs both finishing the wizard) a no-op on the original stamp. A network failure on the POST does **not** strand the user — the hook gate just catches them again on the next load.

### 3. Quickstart checklist (live progress signals)

- `GET /api/quickstart` (`getQuickstartSteps(userId)`, `src/db/queries/quickstart.ts`) returns `{ steps: { provider, chat, extension, agent } }` — four booleans, each a `LIMIT 1` existence probe run concurrently via `Promise.all`:
  - **provider** — any `settings.key LIKE 'provider:apiKey:%' OR 'provider:oauth:%'`.
  - **chat** — any root conversation owned by the user (`userId = ? AND parentConversationId IS NULL`, i.e. excludes sub-conversations).
  - **extension** — any `extensions` row whose `name != 'builtin-tools'` (the always-present built-in tools pack is ignored).
  - **agent** — any `agentConfigs` row owned by the user.
- `QuickStartChecklist.svelte` (rendered once in `(app)/+layout.svelte`) fetches `/api/quickstart` on mount and renders a collapsible "Get Started N/4" card with a progress bar and four deep-link rows (`/settings`, the active project's chat, `/marketplace`, `/agents/new`). Provider creds are deny-listed from the client `store.settings`, so the `provider` signal **must** come from the API; agents also live in the store, so the checklist ORs the API `agent` flag with a live `store.agentConfigs.length > 0` derived signal.
- **Dismissal** is client-only: persisted to `localStorage` under `pi-quickstart` as `{ dismissed }`. The card auto-dismisses once all four steps are done, and the manual ✕ only appears after progress > 0 (so a brand-new user can't dismiss before doing anything). Completion state itself is server-derived — `localStorage` only remembers the dismiss.

## Usage

### API routes

| Method & path | Auth / public | Purpose |
|---|---|---|
| `POST /api/auth/setup` | **public** (first-run only) | Create the first admin. Body `{name,email,password}`. `403` once any human user exists; rate-limited 3/hr/IP. Returns `201` + session cookie. |
| `GET /api/quickstart` | `read` scope + auth | Returns `{ steps: { provider, chat, extension, agent } }` for the calling user. |
| `POST /api/onboarding/complete` | auth | First-write-wins stamp of `users.onboarded_at`. Returns `204`. |

### Page entry points

- `/setup` — first-admin form (public; redirects to `/login` if setup is done).
- `/onboarding` — three-step welcome wizard (auth required; un-onboarded users are force-redirected here from any page).
- The **"Get Started" checklist** appears inside the authenticated app shell (`(app)/+layout.svelte`) until dismissed or fully complete.

### Settings keys touched

- `instance:initialized` (set `true` by setup) — instance-level bootstrap marker.
- `provider:defaultTier` (`quality`/`balanced`/`budget`) — written by wizard step 2 only if the user picked a tier.
- `provider:apiKey:*` / `provider:oauth:*` — their presence drives the `provider` quickstart step (written elsewhere, by the provider-key flow).

## Key files

- `web/src/hooks.server.ts` — the three gates: `getUserCount()===0` → `/setup`; per-user `onboarded_at IS NULL` (pages-only) → `/onboarding`; stashes `onboardedAt` on `locals`.
- `web/src/routes/(auth)/setup/+page.server.ts` — `/setup` load; redirects to `/login` if already set up.
- `web/src/routes/(auth)/setup/+page.svelte` — first-admin form UI.
- `web/src/routes/api/auth/setup/+server.ts` — first-admin bootstrap: rate limit, count gate, create admin, session row, cookie, audit.
- `web/src/routes/api/auth/setup/schema.ts` — `setupSchema` (`name`/`email`/`password`).
- `web/src/routes/(auth)/onboarding/+page.server.ts` — wizard load; `{ user, hasProvider }`; redirects out if already onboarded.
- `web/src/routes/(auth)/onboarding/+page.svelte` — three-step welcome wizard; POSTs `/api/onboarding/complete`, then full reload.
- `web/src/routes/api/onboarding/complete/+server.ts` — `markUserOnboarded`; returns 204.
- `web/src/routes/api/quickstart/+server.ts` — `read`-scoped; returns `{ steps }`.
- `src/db/queries/quickstart.ts` — `getQuickstartSteps` (four `LIMIT 1` probes) + `hasAnyProvider`.
- `src/db/queries/users.ts` — `getUserCount` (excludes `sys-*`), `getUserById`, `createUser`, `markUserOnboarded` (first-write-wins).
- `web/src/lib/components/QuickStartChecklist.svelte` — checklist UI; mount-fetch, `localStorage` dismiss, store fallbacks.
- `web/src/routes/(app)/+layout.svelte` — renders the checklist in the app shell.
- `src/db/schema.ts` — `users.onboarded_at` (`timestamp`, nullable) column.
- `web/src/app.d.ts` — `App.Locals.onboardedAt?: Date | null` (stashed by the hook).

## Features it touches

- [[authentication]] — setup creates the first admin + session; the onboarding gate runs after auth resolves in `hooks.server.ts`.
- [[api-security]] — `/api/quickstart` is `requireScope("read")` + `requireAuth`; `/api/auth/setup` is rate-limited and count-gated; the onboarding gate is pages-only so API/Bearer clients bypass.
- [[providers-and-models]] — step 1 of the wizard embeds provider-key setup; the `provider` quickstart step probes `provider:apiKey:*`/`provider:oauth:*`; step 2 writes `provider:defaultTier`.
- [[settings-system]] — `instance:initialized` and `provider:defaultTier` are settings KV writes; the checklist reads provider state via the API because creds are deny-listed from the client store.
- [[conversations]] — the `chat` quickstart step probes for a user-owned root conversation (excludes sub-conversations).
- [[marketplace]] — the `extension` step probes the `extensions` table (ignoring `builtin-tools`); the checklist deep-links to `/marketplace`.
- [[agents]] — the `agent` step probes `agentConfigs`; the checklist deep-links to `/agents/new`.
- [[mention-grammar]] — wizard step 3 is a primer that teaches a **subset** of the composer mention sigils (`@`/`!`/`/`); the full grammar defines more (see the [[mention-grammar]] doc).
- [[deployment-and-releases]] — first-run setup is the human-facing tail of a fresh deploy; documented operationally in `docs/quick-start.md`.
- [[audit-and-observability]] — setup records a `user:registered` audit entry.

## Related docs

- [quick-start.md](../../quick-start.md) — the operator-facing deploy + first-login walkthrough (create admin, add a provider key). This doc is the engineering reference for the code paths behind it.
- [authentication](authentication.md) — session/cookie/JWT mechanics the setup handler mirrors.

## Notes & gotchas

- **`getUserCount()` is `sys-*`-filtered, by design.** The first-run gate means "has a human admin registered?", not "is any user row present?". Without the `NOT LIKE 'sys-%'` filter, a fresh instance with `ai-kit` (which seeds synthetic system users on boot) would read as already-set-up and route to `/login` forever. Don't "simplify" this to a bare row count.
- **The quickstart response is nested.** It's `{ steps: { provider, chat, extension, agent } }`, **not** a flat object. The checklist reads `data.steps`; a flat read silently shows zero progress.
- **The onboarding gate is pages-only.** API routes (cookie **or** Bearer) and `/_app/` assets skip the `/onboarding` redirect entirely, so a programmatic client (e.g. an issued API key) is never bounced through the wizard. Only real page navigations are gated.
- **Wizard completion is fail-safe, not transactional.** A network failure on `POST /api/onboarding/complete` doesn't strand the user — `markUserOnboarded` just didn't stamp, so the hook gate redirects them back to `/onboarding` next load. The "Get started" button uses a **full reload** (`window.location.href`), not `goto`, specifically so the hook re-reads the fresh `onboarded_at`.
- **First-write-wins stamp.** `markUserOnboarded` only writes when `onboarded_at IS NULL`, so two tabs finishing the wizard concurrently can't advance the original timestamp (it returns `false` for the loser). There is no way to "re-onboard" a user short of nulling the column directly.
- **Setup must create a session row, not just a JWT.** The handler mirrors the login flow's `createSession(...)` so the revocation check in `hooks.server.ts` (missing session row ⇒ revoked) accepts the cookie on the brand-new admin's very next navigation. Dropping that call regresses to an immediate post-setup bounce to `/login`.
- **Checklist dismissal is per-browser, not per-account.** The `pi-quickstart` `{ dismissed }` flag lives in `localStorage`; clearing storage or switching browsers re-surfaces the card (completion itself is recomputed server-side, so it won't show steps you've already done as undone). The manual ✕ is hidden until at least one step is complete.
- **`provider` and `agent` signals have asymmetric sources.** Provider creds are deny-listed from the client `store.settings`, so `provider` can only come from `/api/quickstart`; `agent` is ORed with a live `store.agentConfigs.length > 0` derived signal, so the checklist can light up the agent step from the store even before the API round-trip resolves.
