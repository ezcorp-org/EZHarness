# Capability expiry sweep — design doc

**Status:** Historical design; the capability-expiry configuration, sweep, and host maintenance daemon are implemented. Current code is authoritative. Updated 2026-09-12 for factory planning.
**Author:** post-perm-cleanup build executor (handoff for a future implementation phase).
**Source phases:** Phase 6 (always-allow grants), Phase 51 (cron schedule daemon).

This document connects two pieces that already exist — `grantedAt`
timestamps on every persisted permission, and the cron daemon at
`src/extensions/schedule-daemon.ts` — into a sweep job that re-prompts
the user for grants that have aged past a configurable lifetime.

The original proposal below records the design at that time. The current
implementation is in `src/extensions/perm-expiry-config.ts`,
`src/extensions/perm-expiry-sweep.ts`, and
`src/extensions/host-maintenance-daemon.ts`. Factory maintenance extends
that daemon with a sub-tick. It must not add a second expiry scheduler.
The factory service-principal expiry column is separate from this grant sweep.

---

## 1. Data model

### 1.1 Where `grantedAt` already lives

`grantedAt` is a flat `Record<string, number>` (permission key →
millisecond Unix timestamp) on `ExtensionPermissions` itself
(`src/extensions/types.ts:613`). It rides inside the same JSON column
that persists the permission object on the `extensions` table. Every
caller that creates a granted-permissions object populates it:

- `src/cli.ts:86-95` — install-time grants from CLI flags.
- `src/cli.ts:98-128` — interactive install prompts.
- `src/extensions/bundled.ts:50-128` — bundled-extension grants
  (auto-issued for trusted bundled extensions; `Date.now()` at install).

Permission keys covered today: `network`, `filesystem`, `shell`, `env`,
`storage`, `taskEvents`, `eventSubscriptions`, `appendMessages`,
`spawnAgents`, `agentConfig`, `llm`, `memory`, `lessons`, `schedule`.

The Phase 6 always-allow rows (the user's "don't ask again" toggle on
the in-chat permission modal) are stored separately as `settings` rows
keyed by `alwaysAllowSettingKey({extensionId, userId, scope, scopeId,
capability})` — see `src/extensions/permissions.ts:206-214`. **Those
rows have no `grantedAt`.** This doc proposes adding one (§ 1.3).

### 1.2 No schema change to `ExtensionPermissions`

The existing `grantedAt: Record<string, number>` field already covers
install-time grants. A sweep that revokes per-key would simply delete
the matching `grantedAt[key]` and the matching permission entry on the
extensions row, then write an audit row.

### 1.3 Missing piece: `grantedAt` on always-allow rows

Always-allow rows (`ext:<id>:<user>:<scope>:<scopeId>:always_allow:<cap>`)
currently store a single `boolean`. To expire them we need the grant
timestamp.

**Recommendation:** widen the value shape from `true` to
`{allowed: true, grantedAt: <unix-ms>}`. The settings store accepts
arbitrary JSON, so this is a wire-format-only change. Backwards
compatibility:

- `value === true` → treat as "no expiry, legacy row" (sweep skips it
  initially; admin UI shows it as "legacy — never expires" until the
  user re-prompts).
- `value === { allowed: true, grantedAt: number }` → the sweep
  inspects the timestamp.
- `value === false` (rare — only used by an explicit deny path) →
  unchanged.

Alternative: a parallel `_grantedAt` setting key. Avoid that — it
doubles the read traffic and creates split-brain on partial writes.

### 1.4 Missing piece: `grantedAt` on conversation-scope and project-scope

Same shape change applies. Session-scope rows (cleared on restart)
don't need expiry — they're already short-lived by definition.

---

## 2. Sweep job

### 2.1 Cadence

**Recommendation: hourly.** The cron daemon already wakes every 30s
(`DEFAULT_WAKE_MS`); a sweep that runs every hour fits naturally as a
host-scoped scheduled job alongside the existing extension cron
schedules. Hourly is a balance between:

- Tightness: a 90-day grant expiring at noon shouldn't first be noticed
  at 11:59pm the same day.
- Cheapness: the sweep is a single SQL `SELECT … WHERE grantedAt + ttl
  < now()` followed by a small batch of UPDATEs. Hourly is plenty.

A future tuning knob: `EZCORP_PERM_SWEEP_INTERVAL_MS` env var, default
`3600_000`, override for tests + low-traffic deployments.

### 2.2 Daemon hookup

The schedule-daemon is currently scoped to **extension-defined cron
schedules** — each row in `extension_schedules` belongs to an extension
and fires `ezcorp/schedule.fired` notifications. The expiry sweep is
**host infrastructure**, not extension-owned, so it should NOT reuse
the same table.

**Recommendation:** create a sibling `HostMaintenanceDaemon` (or
extend `schedule-daemon.ts` with a non-extension-scoped tick) that
runs the sweep. The PID lockfile pattern in `schedule-daemon.ts:140-150`
applies — re-using the same pattern keeps operations surface area
small.

Alternative: register the sweep as an internal extension's schedule
(an "ezcorp:perm-expiry" extension that ships in `bundled.ts`).
**Reject this** — internal extensions reusing the schedule table to
host non-extension work conflates user-visible schedule rows with
plumbing. The schedule UI would surface "ezcorp:perm-expiry" runs as
extension fires, which is wrong.

### 2.3 Query shape

```sql
-- Per-extension permission grants past TTL:
SELECT id, granted_permissions
  FROM extensions
 WHERE enabled = TRUE
   AND granted_permissions IS NOT NULL;
-- App layer iterates `grantedAt` keys, computes age = now - ts,
-- compares against TTL by capability kind.

-- Always-allow rows past TTL:
SELECT key, value
  FROM settings
 WHERE key LIKE 'ext:%:always_allow:%';
-- App layer parses `{allowed, grantedAt}`, computes age.
```

Drizzle equivalents:

```ts
const enabledRows = await db
  .select({ id: extensions.id, perms: extensions.grantedPermissions })
  .from(extensions)
  .where(eq(extensions.enabled, true));

const alwaysAllowRows = await db
  .select({ key: settings.key, value: settings.value })
  .from(settings)
  .where(like(settings.key, "ext:%:always_allow:%"));
```

The sweep does NOT need to be transactional with the dispatch — if the
host crashes mid-sweep, the next tick picks up where it left off (rows
that were already revoked are idempotent: their `grantedAt` is gone).

### 2.4 What "expired" means

Per-capability TTL table (proposal — values can move during impl):

| Capability                    | TTL      | Rationale                                                    |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `filesystem` (write)          | 30 days  | Most sensitive; tightest cycle.                              |
| `filesystem` (read-only)      | 90 days  | Lower risk; fewer surprises.                                 |
| `shell`                       | 30 days  | Effectively unrestricted; tighten.                           |
| `network` (per-host allowlist)| 90 days  | Hosts already narrow blast radius.                           |
| `env`                         | 90 days  | Static credentials; periodic rotation prompt.                |
| `storage`                     | Never    | Per-extension storage namespace; isolated.                   |
| `taskEvents`, `appendMessages`| Never    | Behavioral capabilities, no data leak.                       |
| `llm`                         | 90 days  | Cost-bearing; periodic re-consent.                           |
| `memory`, `lessons`           | 90 days  | Cross-conversation persistence; periodic re-consent.         |
| `schedule`                    | Never    | Bounded by extension's `maxRunsPerDay`.                      |
| Always-allow (per scope)      | See §2.5 |                                                              |

A `Never` TTL means the sweep skips the entry entirely. The TTL table
lives in code (`src/extensions/perm-expiry-config.ts` proposal) so it
can be unit-tested.

### 2.5 Always-allow scopes — what expires when

| Scope          | TTL                 | Notes                                                 |
| -------------- | ------------------- | ----------------------------------------------------- |
| `session`      | N/A — restart-bound | Server restart clears the in-memory session set.      |
| `conversation` | Lifetime of conv    | Conversation deletion → row orphaned (cleanup §2.7).  |
| `project`      | 30 days             | Per-project trust expires faster than per-conv.       |
| `forever`      | 90 days (default)   | "Forever" is hyperbolic — means "until expiry sweep". |

### 2.6 What "expire" does

For each expired entry:

1. Remove the matching `grantedAt[key]` from the extensions row's
   `grantedPermissions`.
2. Remove the matching permission value from `grantedPermissions`
   (e.g. `network: ["api.example.com"]` → field deleted entirely).
3. Write an audit row with action `EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED`
   (new constant) and metadata `{capability, scope, ttlMs, ageMs}`.
4. Emit a host-internal event (`event:perm-expired`) so any open admin
   UI can refresh its grant table.

Always-allow rows: replace the row's value with `false` (an explicit
deny is the sweep's default for legacy rows that lack `grantedAt`).

### 2.7 Orphan cleanup (out of scope for v1)

When an extension is uninstalled, its always-allow rows aren't deleted
(`src/extensions/permissions.ts:204` notes this). The sweep CAN
opportunistically delete orphan rows when it encounters them, but this
is a v1.5 enhancement — v1 leaves the orphan-cleanup job out and just
targets the expiry surface.

---

## 3. UX surface

### 3.1 Where the re-approve prompt appears

**Recommendation: both** the existing in-chat permission modal AND a
new banner on `/settings/extensions/[id]`.

- **In-chat modal** (existing): the next time a tool call needs the
  expired capability, the PDP returns `deny` with reason
  `"capability expired"`, the runtime catches that and re-renders the
  same Phase 6 permission modal that the user saw at install. Same
  flow as a fresh prompt; the "Always allow" toggle resets the TTL on
  approval.
- **Settings page banner**: a non-blocking notification showing
  "These grants expired in the last 7 days; re-approve to keep using
  $tool" so the user can proactively reapprove without waiting for the
  tool call to hit a deny. Helpful for scheduled extensions that run
  while the user isn't watching.

### 3.2 Copy guidance

Modal title: "Re-approve $extensionName: $capability"
Modal body: "Your permission for $capability expired $age ago. Continue
to grant for another $newTtl, or cancel."
Buttons: `Approve $newTtl` / `Approve forever (admin only)` / `Cancel`.

The "Approve forever (admin only)" button is gated by the user's role
— regular users see "Approve $newTtl" only. This prevents users from
accidentally bypassing the sweep by ticking a "never expires" box on
every prompt.

### 3.3 What happens if the user dismisses

Treat dismissal as "deny for this call, keep the row in
expired-but-not-revoked state". The sweep's revoke action (§ 2.6) is
still authoritative: dismissal doesn't undo it. The extension's tool
call surfaces an error; subsequent calls re-prompt until the user
either approves or explicitly revokes.

---

## 4. Edge cases

### 4.1 Already-revoked grants

If the user manually revoked the grant before sweep ran, the
permission key is gone from `grantedPermissions` and `grantedAt` —
nothing to expire. Sweep is a no-op for that extension.

### 4.2 Deleted extensions

If the extensions row is gone (uninstalled), there's nothing to sweep.
Always-allow rows for the gone extension are orphans (§ 2.7).

### 4.3 Extensions disabled by failure cap

`enabled === false` is a soft signal — disable doesn't drop grants
(by design, so re-enable preserves the user's prior approval). Sweep
skips disabled extensions (`WHERE enabled = TRUE` in the query) so
disabled-then-re-enabled extensions don't hit a fresh prompt
immediately. **Open question (§ 6.1):** is that the right call?

### 4.4 Grants on the four scopes

Each scope has its own TTL (§ 2.5). The sweep iterates per-scope:
session is skipped (in-memory only), conversation is bounded by
conversation lifetime (parallel — sweep doesn't need to age it),
project + forever are time-bounded.

### 4.5 In-flight tool calls when a grant expires

The PDP authorizes per-call. A tool call that started before expiry
and is still executing keeps the authorization it received at call
start; the grant goes away mid-call only for the NEXT call. If the
tool spawns a sub-call, the sub-call hits the PDP again and gets
denied — that's fine, surfaces as an error in the tool's own logic.

Alternative: track in-flight calls and let them complete on a
short grace window (≤30s). Reject — adds state to the PDP for a
marginal UX win.

### 4.6 Race: sweep runs while user is mid-grant

User clicks "Approve" in the modal AT THE SAME TIME the sweep is
revoking the grant. The settings store is a single-row UPDATE per key,
so the last writer wins. Order of operations:

1. Sweep reads `grantedAt = T0`, decides to revoke.
2. User approves; setting writes `grantedAt = T1` (now).
3. Sweep writes `grantedAt deleted, value: false`.
4. User's next tool call → denied.

This is annoying but recoverable: the user sees the deny, re-clicks
approve, and the grant lands cleanly. **Mitigation:** sweep does a
read-modify-write under a SELECT FOR UPDATE if the underlying SQL
backend supports it (PGlite + native Postgres both do); falls back to
a CHECK clause on the UPDATE (`WHERE granted_permissions = $original`)
if not.

---

## 5. Non-goals (this round)

- **No schema migration.** All the data lives in existing JSON columns.
- **No new UI components.** The existing permission modal + settings
  page are reused; only the rendering condition changes (show the
  modal when the PDP returns `deny: capability expired`).
- **No notification channel beyond in-app.** Email / push notifications
  are explicitly out of scope.
- **No per-user TTL override.** Admin UI for "this user's filesystem
  TTL is 7 days, not 30" is deferred.
- **No automatic re-approval on heuristics** (e.g. "user used this
  tool 50 times this week → bump TTL"). Behaviorally-driven trust is
  a v2 feature with its own design doc.

---

## 6. Open questions

### 6.1 `forever` scope expiry policy

Default 90 days as proposed in § 2.5. Alternatives:

- 30 days (tighter, more re-prompts).
- Configurable per scope via env var, default 90.
- Configurable per scope per capability via admin UI (maximalist —
  defer to v2).

**Recommended for v1:** single env var `EZCORP_PERM_FOREVER_TTL_DAYS`,
default `90`. Per-capability TTL override is v1.5.

### 6.2 Notification channel

In-app banner only for v1. Email / push channels need:

- Email opt-in stored on the user.
- A separate `notifications` table (doesn't exist).
- A "digest" sweep that batches expirations to avoid mailbomb on a
  user with 30 extensions.

All three are individually larger than this whole doc. Defer.

### 6.3 Storage and schedule capabilities — "Never" or 365 days?

§ 2.4 lists `storage` and `schedule` as "Never". That's the
conservative choice — those capabilities have low blast radius. Some
auditors may want a 365-day floor "for hygiene." Either is defensible;
the v1 implementation should pick one and document the choice in the
admin UI tooltip.

### 6.4 Should sweep run on disabled extensions?

§ 4.3 currently skips them. A failure-cap-disabled extension is a
likely-malicious extension; preserving its grants until re-enable is
arguably wrong. Counter: the user explicitly hit re-enable AFTER
disable, so they're making a fresh trust decision; preserving the
grant lets them re-test without re-prompting. **Recommendation:**
preserve grants on `disabled` (failure-cap), revoke on
`uninstalled`. Stage the impl so this is a 1-line policy flag.

---

## 7. Test plan (for the implementation phase)

These tests are NOT in this PR. Listed so the implementation phase
can claim coverage parity with the rest of the perm system.

**Unit tests (`src/__tests__/perm-expiry.test.ts`):**

- `computeExpiry(grantedAt, ttlMs, now)` returns `{expired: bool, ageMs}`.
- Per-capability TTL table is the single source of truth (no magic
  numbers in the sweep code).
- Always-allow value migration: legacy `true` → treated as never-expires
  on read.

**Integration tests (`src/__tests__/perm-expiry-sweep.integration.test.ts`):**

- Sweep against a synthetic DB with 100 extensions, 50% expired:
  asserts only the expired half is revoked.
- Audit row written for every revocation.
- Race-mitigation: `SELECT FOR UPDATE` on the read.

**E2E (`web/src/routes/.../perm-expiry.test.ts`):**

- User installs extension → sweep advances clock → user opens
  settings page → banner is shown → click "re-approve" → row's
  `grantedAt` resets to now.

**Property tests (idempotence):**

- Run sweep N times in a row with no grant changes between → audit
  log gets exactly N revocations on round 1, zero on rounds 2+.

---

## 8. Estimated scope

Per-section line-of-code estimates so the next ez-feature plan can
size sub-phases:

| Section                                 | LOC estimate |
| --------------------------------------- | ------------ |
| Always-allow value-shape migration (§1.3)  | ~150         |
| Sweep core (`perm-expiry-sweep.ts`)        | ~300         |
| Daemon registration + lockfile             | ~80          |
| TTL config table + tests                   | ~100         |
| Audit action + emit (`event:perm-expired`) | ~50          |
| Modal copy + role-gating                   | ~100         |
| Settings-page banner                       | ~150         |
| Tests (per § 7)                            | ~600         |
| **Total**                                  | **~1,530**   |

That's a 1-2 week single-developer phase, not a single PR.

---

## 9. Auth model — reapprove vs admin policy override

The `POST /api/extensions/[id]/reapprove` endpoint uses
`requireAuth(locals)` (any authenticated user), while the peer
`PUT /api/extensions/[id]/permissions` uses `requireRole(locals, "admin")`.
The asymmetry is intentional and reflects two distinct authorization
categories:

| Endpoint                                       | Operation class                                    | Auth gate                              | Audit reason                          |
| ---------------------------------------------- | -------------------------------------------------- | -------------------------------------- | ------------------------------------- |
| `POST .../reapprove` (default)                 | User self-service recovery from expiry sweep       | `requireAuth` (any user)               | `"user-reapprove"`                    |
| `POST .../reapprove` with `scope="forever"`    | User-requested escalation to never-expire grant    | `requireAuth` + `requireRole(admin)`   | `"user-reapprove (admin: forever)"`   |
| `PUT .../permissions`                          | Admin policy override (arbitrary grant/revoke)     | `requireRole(admin)`                   | `"admin-grant"` / `"admin-revoke"`    |

The default reapprove path is **bounded by the manifest ceiling**: it
re-grants exactly what the extension's author declared and the user/admin
already approved at install time (see the grant lookup at
`web/src/routes/api/extensions/[id]/reapprove/+server.ts:116-132`). A
non-admin user cannot escalate beyond that ceiling. The `scope="forever"`
option carries a separate `requireRole(admin)` check (line 102-104) as
defense in depth — a tampered DOM cannot escalate without the admin role.

By contrast, `PUT .../permissions` lets an admin **bypass the user's
original install-time consent**, which is why it requires the admin role
unconditionally. Audit logs record the source of authority (user-driven
vs admin-driven) so reviewers can tell the two apart.

This was flagged for security review in the v1.3 roadmap closeout pass
(2026-05-09) and confirmed correct-by-design.
