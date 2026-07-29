# C2 implementation spec — dynamic cron and webhook triggers

**Status:** Binding for phase 5
**Date:** 2026-07-29
**Implements:** C2 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Scope:** `src/extensions/**`, `packages/@ezcorp/sdk/src/runtime/`, `src/db/`, `web/src/routes/api/hooks/**`

> **Citation anchor.** Verified at **`50e73ec5`**. C2 lives almost entirely in
> `src/extensions/**` and the SDK, which phase 2 does not touch, so those
> citations are stable. **`src/db/schema.ts` is the exception** — phase 2 is
> actively adding columns to it (`50e73ec5` moved `uniq_ext_schedule` from
> :1414 to :1546), so re-verify any schema line before relying on it. Anchor on
> the **symbol name**, not the number.

**§1 is the reason this document exists.** Two of the four findings there
invalidate part of C2 as specced in the plan — read it before designing
anything.

> ### ⚠ Phase 5 alone does not deliver the headline use case
> "A user creates a job that fires Mondays 3am and runs the docs-factory
> workflow" **does not work when C2 ships.** The cron fires, the handler runs,
> and `ctx.workflows.run(...)` is **refused with `-32106`** — cron fires are
> ownerless by construction (`src/extensions/schedule-daemon.ts:409-413`), and
> every owner-scoped capability soft-fails from them.
>
> **C2 delivers the trigger. C3 (phase 7) delivers the ability to act on it.**
> The phase order is right; the expectation is the thing to manage. Do not demo
> phase 5 with a workflow-running job, and do not describe C2 as "users can
> create jobs" without the qualifier — the person who reads that sentence will
> write exactly that job and hit a refusal. See §1.5.

---

## 1. Findings against the real source

### 1.1 Hazard A — `reconcileWebhooks` soft-disables dynamic slugs · **CONFIRMED**

`reconcileWebhooks` (`src/extensions/webhook-reconcile.ts:28`) treats the
**grant** as the complete set of legitimate slugs and disables everything else:

- `:84-91` — when the grant is non-empty:
  `UPDATE … SET enabled = false WHERE extension_id = $1 AND slug NOT IN (valid) AND enabled = true`.
- `:92-100` — when the grant declares **no** slugs, it disables **all** of them.

**This is correct behaviour today.** Every slug that currently exists is
manifest-declared, so disabling the non-granted ones is exactly what the
reconciler is for. The hazard is **latent, and C2 activates it**: a dynamic slug
is by construction absent from the manifest and therefore from the clamped grant
(`clamp-permissions.ts:766-777` intersects `submitted ∩ manifest`), so **once
dynamic rows exist, every install, update, or permission change silently
disables every user-created webhook trigger.** The failure is invisible — the row
stays, the secret stays, delivery history stays, and the hook simply stops
firing.

There is a second-order defect in the same function: `disabled` is counted from
a pre-fetch snapshot at `:55` (because PGlite's UPDATE `rowCount` is
unreliable). Dynamic rows must be excluded from **that snapshot too**, or the
audited count is wrong even after the disable is fixed.

**Design:** both the `notInArray` sweep and the snapshot filter gain
`AND dynamic = false`. Same change, same shape, in `reconcileSchedules`
(`src/extensions/schedule-reconcile.ts:55-73`, including the disable-all branch
at `:64-73`).

### 1.2 Hazard B — `uniq_ext_schedule` blocks two jobs sharing a cron · **CONFIRMED**

`uniqueIndex("uniq_ext_schedule").on(extensionId, cron)`
(`src/db/schema.ts:1546`, DDL at `src/db/migrate.ts:1602`) makes
`(extension_id, cron)` unique. Two users each wanting `0 9 * * 1` is the normal
case, not an edge case, and the second registration fails with a constraint
violation.

**Is widening safe against existing rows?** Yes, and it needs no data rewrite.
Every existing row is manifest-declared, so under the new schema every one has
`dynamic = false` and `key IS NULL`. Replace one total index with two partials:

```sql
DROP INDEX IF EXISTS uniq_ext_schedule;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_schedule_manifest
  ON extension_schedules(extension_id, cron) WHERE dynamic = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_schedule_dynamic
  ON extension_schedules(extension_id, key) WHERE key IS NOT NULL;
```

The manifest partial preserves today's dedupe **exactly** for every existing
row; the dynamic partial makes `key` the identity for user-created rows, so a
cron expression may repeat freely. The `DROP` is the only non-additive
statement in C2 — it is safe because the replacement is created in the same
migration pass and covers a strict superset of the old constraint's rows. It is
idempotent: `DROP … IF EXISTS` + `CREATE … IF NOT EXISTS` re-runs cleanly.

Same treatment for `uniq_ext_webhook` (`src/db/schema.ts:1595`, DDL
`migrate.ts:1636`) — slug is already unique per extension and host-minted slugs
are collision-free by construction (§4), so the dynamic partial is on
`(extension_id, key)` and the manifest partial keeps `(extension_id, slug)`.

### 1.3 Finding C — **the SDK dispatch is keyed by cron string, so it cannot be reused** · NEW

This is the one that invalidates part of the plan. The design record says
dynamic crons ride "**the same daemon, the same validator, the same quotas, the
same auto-disable**". The daemon, validator, quotas and auto-disable are all
genuinely reusable. **The dispatch is not.**

`packages/@ezcorp/sdk/src/runtime/schedule.ts:34` resolves the handler as:

```ts
const handler = handlers.get(ctx.cron);
```

Handlers are registered by cron expression (`:47` `on(cron, handler)`). So once
two dynamic jobs share `0 9 * * 1`:

- both fires resolve to the **same** handler, and
- the handler **cannot tell which job fired** — `ScheduleHandlerContext`
  (`schedule.ts:14-22`) carries `cron`, `scheduledAt`, `firedAt`, `fireId`,
  `catchUp`, `retry`, `attempt`, and no job identity at all.

Fixing Hazard B at the DB layer without fixing this produces a system that
*stores* two jobs correctly and *runs* them indistinguishably — worse than the
constraint violation, because it fails silently.

**Design:** `ctx.triggers` gets its **own** receiver and its own registry keyed
by `key`, not cron:

- new reverse-RPC notification **`ezcorp/trigger-fire`**, payload
  `{ v: 1, key, kind: "cron" | "webhook", firedAt, fireId, catchUp, attempt, payload? }`;
- `ctx.triggers.on(key, handler)` registers into a `Map<key, handler>`;
- the daemon dispatches `ezcorp/trigger-fire` for a row with `dynamic = true`
  and the existing `ezcorp/schedule-fire` for a manifest row.

`Schedule.on` and `ezcorp/schedule-fire` are **untouched**, so every existing
extension keeps working byte-identically. The branch is one `if (row.dynamic)`
in the daemon's dispatch.

### 1.4 Finding D — `maxRunsPerDay` is per-**extension**, so dynamic jobs share one pool · NEW

`todaysFireCount(extensionId)` (`src/extensions/schedule-daemon.ts:647`, called
at `:266` and `:372`) counts fires for the **whole extension**, and the quota
gate at `:266-268` compares that single number against `grant.maxRunsPerDay`.

With 25 dynamic crons under one `ez-factory` install, all 25 jobs draw on one
budget. A single busy job (say every 5 minutes, 288 fires/day) exhausts a
500-fire envelope before lunch and **starves the other 24** — and the starved
jobs' only signal is a quota-exceeded audit row against the extension, naming
no job.

`permissions.triggers.maxRunsPerDay` is therefore an **envelope, not a
per-job allowance**, and C2 must add per-job fairness or the feature is unusable
at its own advertised limits. The cheapest correct design:

- keep the extension-wide gate exactly as-is (it is the spend bound);
- add a **per-key daily cap** — `extension_schedules.max_runs_per_day`,
  nullable, defaulting to `floor(envelope / maxCron)` at registration — checked
  against a per-key count before the extension-wide check;
- when the extension-wide gate trips, the audit row names the **key** that was
  being claimed, so the starved job is diagnosable.

### 1.5 Finding E — a dynamic cron job cannot run a workflow until C3 · NEW

`dispatchFire` (`schedule-daemon.ts:395`) documents the attribution reality at
`:409-413`: cron fires have **no conversation and no user** — they are
ownerless, and a reverse-RPC from the fire handler soft-fails `-32106` for every
owner-scoped capability.

So "a user creates a job that fires Mondays 3am and runs the docs-factory
workflow" is **not** deliverable by C2 alone: the cron fires, the handler runs,
and `ctx.workflows.run(...)` is refused. C2 delivers the *trigger*; **C3
(`runFor` + delegation) delivers the ability to act on it.**

The plan's phase order already has C2 at 5 and C3 at 7, so the sequencing is
right — but the plan does not say that phase 5 alone leaves the headline use
case non-functional. It should, so nobody demos phase 5 expecting a working job
and finds a `-32106`.

---

## 2. The manifest envelope

`permissions.webhooks` is a bare `string[]` (`src/extensions/types.ts:580`), so
`permissions.triggers` is a **new key**, not a widening of it. Both coexist: an
extension may declare fixed slugs *and* an envelope.

```ts
triggers?: {
  maxCron: number;         // dynamic cron registrations
  maxWebhooks: number;     // dynamic webhook registrations
  webhookPrefix: string;   // slug namespace, e.g. "factory-"
  maxRunsPerDay: number;   // extension-wide fire envelope (§1.4)
};
```

**Grant shape** (`types.ts`, the `ExtensionPermissions` mirror): identical, all
fields required — same discipline as `workflows` (`:947`), where the manifest
form has optionals and the grant form does not, because
`intersectPermissions` does `Math.min` and an absent field would produce `NaN`.

### 2.1 `clampTriggersPermission`

Modelled on `clampSchedulePermission` (`clamp-permissions.ts:402`):

| Field | Clamp | Rationale |
|---|---|---|
| `maxCron` | `min(submitted, manifest)`, range 0–50, default 0 | 0 disables cron registration without dropping the grant |
| `maxWebhooks` | `min(submitted, manifest)`, range 0–50, default 0 | |
| `webhookPrefix` | **manifest only**, never the submitted value; must match `/^[a-z0-9][a-z0-9-]{0,15}-$/` | the prefix is a namespace claim; letting the install grant widen it would let a user hand one extension another's namespace |
| `maxRunsPerDay` | `min(submitted, manifest)`, range 1–2000, default 100 | |

Return `undefined` when `manifest` is absent (mirrors `:406`) and when both
`maxCron` and `maxWebhooks` clamp to 0 — an envelope authorizing zero
registrations is a husk, and `clampWorkflowsPermission` (`:274`) sets the
precedent of dropping rather than storing one.

### 2.2 When the manifest later narrows

The grant is re-clamped at update. Three cases, all of which must be
**non-destructive**:

| Manifest change | Effect on existing dynamic rows |
|---|---|
| `maxCron` lowered below the current row count | Existing rows keep running; **new** registrations are refused with `TRIGGERS_QUOTA_EXCEEDED` until the count falls below the new cap. Never silently disable rows the user created under a larger cap. |
| `webhookPrefix` changed | Existing slugs keep working (the row is the source of truth for routing). New slugs use the new prefix. Audited as a manifest change. |
| `triggers` removed entirely | All dynamic rows **soft-disabled** (`enabled = false`), rows preserved, one audit entry per row. This is the one case where disabling is correct — the capability itself is gone. |

The reconcilers' `dynamic = false` filter (§1.1) means dynamic rows are
untouched by ordinary reconciliation; case 3 is an **explicit** sweep, not a
side effect of the normal path.

---

## 3. `ctx.triggers` — SDK surface and enforcement ladder

```ts
await ctx.triggers.register({ kind: "cron", key: `job:${id}`, cron: "0 3 * * 1", timezone: "America/New_York" });
await ctx.triggers.register({ kind: "webhook", key: `job:${id}` });
// → { v: 1, key, kind: "webhook", url: "/api/hooks/ez-factory/factory-a1b2c3d4", secretShownOnce }
await ctx.triggers.unregister(`job:${id}`);
await ctx.triggers.list();
ctx.triggers.on(`job:${id}`, async (fire) => { … });   // §1.3
```

Reverse-RPC method **`ezcorp/triggers`**, one handler
`src/extensions/triggers-handler.ts`, `action: "register" | "unregister" | "list"`.

### 3.1 The ladder

Rungs 1–9 mirror `workflows-handler.ts` exactly; the register-specific rungs are
T1–T7. Every outcome — accept **and** reject — writes an `sdk_capability_calls`
row (`capability: "triggers"`, `action: <action>`) with a typed `errorCode`.

| Rung | Check | Deny code |
|---|---|---|
| 0 | Provenance from the host-issued `ezCallId`; unresolved ⇒ `-32602` | — |
| 1 | Kill switch `EZCORP_DISABLE_CAPABILITY_TOOLS=1` | `TRIGGERS_DISABLED` |
| 1b | `EZCORP_DISABLE_DYNAMIC_TRIGGERS=1` — C2 alone, without the whole tier | `DYNAMIC_TRIGGERS_DISABLED` |
| 2 | Structural grant check — `triggers` present, caps positive | `TRIGGERS_NOT_GRANTED` |
| 3 | Manifest re-read (defense-in-depth, `workflows-handler.ts:250-253`) — the live manifest still declares `triggers` | `TRIGGERS_NOT_DECLARED` |
| 4 | PDP `authorize` for `{kind:"ezcorp:triggers:register", value:<kind>}` — per-kind, so cron and webhook are separately grantable | `TRIGGERS_PERM_DENIED` |
| **T1** | `key` shape — `/^[a-z0-9][a-z0-9:_-]{0,63}$/`, non-empty. The key is extension-scoped, never global. | `TRIGGER_KEY_INVALID` |
| **T2** | Kind-specific payload. **cron:** `validateCron(expr)` (`cron.ts:91`) — 5 fields, no shorthand, ≥5-minute interval; `timezone` must resolve. **webhook:** no payload; the host mints everything. | `TRIGGER_CRON_INVALID` / `TRIGGER_BAD_PAYLOAD` |
| **T3** | Cap — count this extension's `dynamic = true` rows of this kind against `maxCron` / `maxWebhooks` | `TRIGGERS_QUOTA_EXCEEDED` |
| **T4** | Idempotency — a register for an existing `key` **updates in place** (same row, same slug, same secret) rather than erroring. Re-registering must be safe; a job editor saving twice is the normal case. | — |
| 5 | Instantaneous rate limit (token bucket, 50 ops/s) | `TRIGGERS_RATE_LIMITED` |
| **T5** | Write the row — `dynamic = true`, `key`, `timezone`, `max_runs_per_day` (§1.4), `next_fire_at` from `parseCron` | `TRIGGERS_WRITE_FAILED` |
| **T6** | For webhooks: mint the slug (§4) and the secret via `ensureWebhookSecret` (`webhook-secret.ts:82`) | `TRIGGERS_SECRET_FAILED` |
| **T7** | Audit — `sdk_capability_calls` **and** an `audit_log` row (`ext:trigger-registered` / `ext:trigger-unregistered`) naming the key and, for cron, the expression | — |

**Why two audit destinations.** `sdk_capability_calls.on_behalf_of` is
`NOT NULL` with an FK to `users`, so it cannot record a registration made from
an ownerless context. Registration is always owner-scoped (a human is editing a
job), so the capability row is always writable — but the **unregister-on-uninstall
sweep** is ownerless, and that is precisely the event an operator most needs a
trail for. It goes to `audit_log`, whose `user_id` is nullable. Same split, same
reason, as the `-32106` rung in `workflows-handler.ts:286-290`.

### 3.2 `list` and `unregister`

`list` returns only this extension's own rows — the extension id comes from the
registry, never the wire, so cross-extension enumeration is inexpressible.
`unregister(key)` deletes the row and, for a webhook, **deletes the secret**;
delivery history is preserved (`webhook_deliveries` FKs the webhook row with
`ON DELETE CASCADE`, so unregister must soft-delete or re-parent — see §6).

---

## 4. Host-minted slugs

The extension supplies a `key`; the **host** derives the slug:

```
slug = `${grant.triggers.webhookPrefix}${sha256(extensionName + "\0" + key).slice(0, 12)}`
```

Three properties, none of which depend on the extension behaving:

1. **Collision across extensions is inexpressible.** The digest is over
   `extensionName` — resolved host-side from the registry
   (`registry.getManifest(extensionId).name`), never the wire — so two
   extensions cannot produce the same slug even with identical keys.
2. **Forgery is inexpressible.** The extension never transmits a slug on
   register, so there is no field in which to name another extension's hook.
   This is the same structural bound namespacing gives workflows
   (`workflows-handler.ts:236-243`).
3. **The prefix is a manifest claim, not a runtime choice** (§2.1), so an
   extension cannot drift into a neighbour's namespace between installs.

The derived slug must still satisfy `WEBHOOK_SLUG_RE`
(`src/extensions/manifest.ts:813`, `/^[a-z0-9][a-z0-9-]{0,63}$/`) — the prefix
clamp guarantees the head character and the hex digest the tail, and the
handler re-validates before writing (defense-in-depth, mirroring
`webhook-reconcile.ts:39`).

The **public route is unchanged.** `POST /api/hooks/[extensionId]/[slug]`
(`web/src/routes/api/hooks/[extensionId]/[slug]/+server.ts:96`) looks up
`getEnabledWebhook(extensionName, slug)` at `:143` and does not care how the row
was created. Dynamic hooks inherit, for free: the pre-lookup per-IP limiter
(`:60-61`), the enumeration-safe 404 on a malformed slug (`:115`), the 256 KB
body cap (`:37`, checked at `:124` and `:133`), constant-time auth
(`webhook-auth.ts:45`, `:68`), and the daily budget (`:40`).

---

## 5. What is reused, and what is not

| Component | Reused? | Note |
|---|---|---|
| `validateCron` (`cron.ts:91`) | **Yes, unchanged** | Same 5-field + ≥5-min rules for dynamic registrations (§7) |
| `parseCron` / `CronInstance` (`cron.ts:317`) | **Yes** | `next_fire_at` computation identical |
| `ScheduleDaemon` claim CAS (`schedule-daemon.ts:290-305`) | **Yes, unchanged** | The CAS is on `(id, next_fire_at)`; `dynamic` is irrelevant to it |
| PID lockfile, concurrency caps, catch-up jitter | **Yes** | |
| Auto-disable after 5 (`schedule-daemon.ts:87`) | **Yes** | A dynamic job that throws 5 times disables itself, same policy |
| Missed-run policy | **Yes** | Read from the same grant |
| `extension_schedule_fires` history | **Yes** | One more FK'd row per fire, no shape change |
| Webhook delivery queue + daemon | **Yes** | The route persists before dispatch regardless of row origin |
| Webhook secret store (`webhook-secret.ts`) | **Yes** | `ensureWebhookSecret` is already mint-if-absent |
| Public hooks route | **Yes, unchanged** | §4 |
| **`reconcileSchedules` / `reconcileWebhooks`** | **No — must change** | §1.1, the `dynamic = false` filter |
| **`uniq_ext_schedule` / `uniq_ext_webhook`** | **No — must change** | §1.2 |
| **SDK dispatch (`schedule.ts:34`)** | **No — cannot be reused** | §1.3, keyed by cron |
| **`maxRunsPerDay` fairness** | **No — needs a per-key cap** | §1.4 |

---

## 6. Lifecycle

The failure mode to design against is an **orphaned trigger that still fires** —
a cron row whose job no longer exists, waking a subprocess to run nothing, or
worse, to run a stale job definition.

| Event | Cron rows | Webhook rows |
|---|---|---|
| **Extension disabled** | Daemon skips (`enabled` gate on the schedule row is separate from extension state — add an extension-enabled join to the claim query, or the daemon fires for a disabled extension) | Route returns 404 via `getEnabledWebhook` |
| **Extension uninstalled** | `extension_schedules.extension_id` FKs `extensions.id` `ON DELETE CASCADE` — rows vanish with the extension | `extension_webhooks.extension_id` FKs `extensions.name` `ON DELETE CASCADE`; **secrets must be deleted explicitly** (`deleteWebhookSecret`) or they outlive the hook |
| **Extension updated** | Untouched (§1.1 filter) unless `triggers` was removed (§2.2 case 3) | Same |
| **Job deleted by the user** | The extension calls `ctx.triggers.unregister(key)`. **If it does not, the row orphans.** | Same |
| **Extension crashes mid-registration** | The row exists, the handler is not registered ⇒ `ezcorp/trigger-fire` finds no handler and drops silently — the same defense-in-depth shape as `schedule.ts:35-40`. Recorded as a fire with `status: ok` and no work done. | n/a |

**The orphan sweep.** Because the last two rows above depend on the extension
behaving, C2 ships a reconciliation the *host* controls: on extension start, the
host sends `ezcorp/triggers-sync` carrying every dynamic key it holds; the
extension replies with the keys it still considers live; the host soft-disables
the difference and writes one `audit_log` row per disabled key. Ownerless, so
audited to `audit_log` (§3.1). Without this, a deleted job's trigger fires
forever and nothing in the system notices.

**Webhook unregister and delivery history.** `webhook_deliveries.webhook_id`
FKs `extension_webhooks.id` `ON DELETE CASCADE`, so a hard delete on unregister
destroys the delivery history an operator may still need. Unregister therefore
**soft-deletes** (`enabled = false`, `key = NULL` to free the partial unique
index) and deletes only the secret. A later `cleanupOldWebhookDeliveries`
(`webhook-store.ts:105`) reaps the history on its own retention schedule.

---

## 7. Cron rules and how the reason reaches the user

`validateCron` (`cron.ts:91`) returns `{ ok: false, reason }` with five distinct
reasons — `"empty"` (`:93`), `"shorthand-not-supported (use 5-field expression)"`
(`:97`), `` `expected 5 fields, got N` `` (`:101`),
`"min-5-min-interval-required"` (`:105`), and `` `parse-error: …` `` (`:111`).

Those rules apply **unchanged** to dynamic registrations — the ≥5-minute floor
is a spend bound, and relaxing it for user-created jobs would be exactly
backwards.

**The reason must reach the human creating the job**, which is a new
requirement: today `validateCron`'s reason is consumed by
`clampSchedulePermission` (`:423-427`) at install time, where the audience is an
extension author reading a warning log. For a job editor the audience is an end
user typing `0 9 * * *` and needing to know *why* it was rejected.

So `TRIGGER_CRON_INVALID` carries `data: { reason }` verbatim from
`validateCron`, and the SDK surfaces it as a typed `TriggerCronError` with a
`reason` field the extension renders next to the field. The reason strings are
already human-legible; they are not rewritten host-side (rewriting would fork
the vocabulary and let the two drift).

---

## 8. Migration plan

Ordered, all idempotent, appended after the existing extension-table DDL.

**`extension_schedules`:**

| Column | Type | Null | Default |
|---|---|---|---|
| `dynamic` | `BOOLEAN` | no | `FALSE` |
| `key` | `TEXT` | yes | — |
| `timezone` | `TEXT` | yes | — |
| `max_runs_per_day` | `INTEGER` | yes | — (§1.4) |

**`extension_webhooks`:** `dynamic BOOLEAN NOT NULL DEFAULT FALSE`, `key TEXT`.

`DEFAULT FALSE` is what makes this backward-safe: every pre-existing row reads
as manifest-declared, so the reconcilers keep managing them exactly as today and
the new partial indexes cover them identically to the old total ones.

**Indexes** — the one non-additive step, justified in §1.2:

```sql
DROP INDEX IF EXISTS uniq_ext_schedule;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_schedule_manifest
  ON extension_schedules(extension_id, cron) WHERE dynamic = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_schedule_dynamic
  ON extension_schedules(extension_id, key) WHERE key IS NOT NULL;
DROP INDEX IF EXISTS uniq_ext_webhook;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_webhook_manifest
  ON extension_webhooks(extension_id, slug) WHERE dynamic = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_webhook_dynamic
  ON extension_webhooks(extension_id, key) WHERE key IS NOT NULL;
```

**No backfill.** Every column's default is already the correct value for every
existing row, so a CTE backfill would be a re-runnable statement that could only
do harm — the opposite of the house rule that backfills touch only still-`NULL`
rows (`docs/features/platform/database-and-migrations.md:125`).

`schema.ts` and `migrate.ts` move in lockstep or the mismatch is silent (`:126`).

---

## 9. Test plan

**New files → threshold keys (all 100):** `src/extensions/triggers-handler.ts`,
`src/extensions/triggers-store.ts`, `packages/@ezcorp/sdk/src/runtime/triggers.ts`
(already covered by the `packages/@ezcorp/sdk/src/**` glob).

**The two highest-value tests in the phase** — both regression guards for §1.1
and §1.2, both cheap:

1. `reconcileSchedules` / `reconcileWebhooks` run with an **empty** grant and a
   dynamic row present ⇒ the dynamic row is **still enabled**, and the reported
   `disabled` count excludes it. Without this, the next manifest edit silently
   kills every user job.
2. Two dynamic registrations with the **same cron expression**, different keys ⇒
   both rows exist, both fire, and each fire carries its own `key`.

**Determinism** — copy the schedule daemon's seams, which exist because this was
solved once already: `now` injection (`schedule-daemon.ts:61-63`), `tick()`
public and directly awaited (`:218-220`), `skipLockfile` / `lockfilePath`
overrides (`:71-73`, `:75-77`). No wall-clock, no sleeps.

**Ladder** — one test per rung including every deny code; the two audit
destinations asserted separately (§3.1); T4 idempotency (register twice ⇒ one
row, same slug, same secret).

**Slug minting** — same `(extension, key)` ⇒ same slug; different extension,
same key ⇒ different slug; derived slug always matches `WEBHOOK_SLUG_RE`.

**Quota** — per-key cap trips before the extension-wide cap; the extension-wide
audit row **names the key** (§1.4).

**Lifecycle** — uninstall cascades rows and deletes secrets; the orphan sweep
disables keys the extension no longer claims; unregister soft-deletes and
preserves delivery history.

**E2E** — `web/e2e/extensions-dynamic-triggers.spec.ts`: register a cron from a
Hub action, see the row, fire it, unregister. `@evidence` — the trigger editor
is a new visual surface.

**Unchanged-path canaries:** the existing schedule and webhook specs must pass
**unmodified**. If any needs editing, dynamic support has leaked into the
manifest path.

---

## 10. Build order

Each step leaves the tree green and the manifest path byte-identical.

| # | Land | Why here |
|---|---|---|
| 1 | Migration + `schema.ts` columns + the four partial indexes. No behaviour. | Hazard B is fixed and provable in isolation, before anything depends on it. |
| 2 | The `dynamic = false` filter in both reconcilers, with the two regression tests. | **Hazard A is fixed before any dynamic row can exist**, so the window in which a user job could be silently disabled never opens. |
| 3 | `triggers-store.ts` — row CRUD, slug minting, per-key quota. Pure, no RPC. | Fully unit-testable alone. |
| 4 | The manifest envelope + `clampTriggersPermission`. | Grants exist before anything reads them. |
| 5 | `triggers-handler.ts` + the ladder + audit. Still no dispatch. | Registration works and is bounded; nothing fires yet. |
| 6 | SDK `ctx.triggers` (`register`/`unregister`/`list`) + `ezcorp/triggers`. | Round-trip testable end to end. |
| 7 | `ezcorp/trigger-fire` + the key-keyed receiver + the daemon's `if (row.dynamic)` branch (§1.3). | The dispatch split, isolated in one commit. |
| 8 | Orphan sweep + lifecycle sweeps (§6). | Needs everything above to have something to reconcile. |
| 9 | Hub trigger editor + `@evidence` spec. | |

Steps 1–2 are a **prerequisite, not an independent bug fix.** The hazard in §1.1
is **latent, not present**: every webhook slug and cron row in existence today is
manifest-declared, so `notInArray(slug, valid)` disabling non-granted slugs is
the *intended* behaviour, correctly implemented. **C2 is what activates the
hazard** — the first dynamic row is the first row that can be wrongly disabled.

That is why steps 1–2 come first: not because they fix something broken now, but
because landing them after any dynamic row exists opens a window in which a user
job can be silently killed. There is nothing here worth landing on its own
merits if the phase stops.

---

## 11. Acceptance criteria

Falsifiable — a named test or a grep per row, no judgement calls. **§11 is a
floor, not a ceiling**; §11.1 is what the rows cannot cover.

| # | Criterion | Proven by |
|---|---|---|
| 1 | Reconcilers leave dynamic rows alone — both the `notInArray` sweep and the `disabled` snapshot (§1.1). | A test running each reconciler with an empty grant + a dynamic row present, asserting the row is still `enabled` **and** the count excludes it. |
| 2 | Two dynamic jobs share a cron expression and stay distinguishable (§1.2, §1.3). | A test registering two keys with identical crons, firing both, asserting each handler receives its own `key`. |
| 3 | The manifest dispatch path is byte-identical. | `Schedule.on` and `ezcorp/schedule-fire` untouched (grep); existing schedule/webhook specs pass **unmodified**. |
| 4 | Slugs are host-minted and collision-free (§4). | Determinism + cross-extension divergence + `WEBHOOK_SLUG_RE` conformance, all asserted; and a grep proving no wire field carries a slug on register. |
| 5 | Cron rules unchanged, and the `reason` reaches the caller (§7). | A test asserting each of `validateCron`'s five reasons surfaces verbatim in `TRIGGER_CRON_INVALID.data.reason`. |
| 6 | Per-key quota exists and the extension-wide denial names the key (§1.4). | A test exhausting one key's cap while another still fires; and an assertion on the audit row's payload. |
| 7 | No orphaned trigger fires (§6). | A test where the extension drops a key from its sync reply ⇒ the row is soft-disabled with an `audit_log` row. |
| 8 | Registration is idempotent (T4). | Register twice ⇒ one row, same slug, same secret. |

### 11.1 Beyond the checklist

- **Interactions:** the per-key quota (row 6) and the auto-disable-after-5 policy
  both write to `extension_schedules`; verify a quota denial does **not**
  increment `consecutive_errors`, or 5 quota-limited days silently disable a
  healthy job. The daemon already draws this distinction for delivery misses
  (`schedule-daemon.ts:478-480`) — the same reasoning applies here.
- **Migration extensibility:** can a later phase add a per-key `enabled` flag, or
  a second trigger kind (`event`), without another `DROP INDEX`? If the partial
  indexes are keyed on `dynamic` rather than on `kind`, adding a kind is
  additive; verify that shape.
- **Meaningless coverage:** the ladder tests must assert the **deny code and the
  audit destination**, not merely that the call was rejected.
- **Untested by default:** two registrations racing on the same key; a
  registration landing between a daemon tick's claim and its dispatch; the
  daemon firing a dynamic row whose extension subprocess is not running.

**And the standing one:** anything here the build proves wrong. §1 already
records four findings against the plan, two of which invalidate part of it —
a fifth is a better outcome than a spec defended past its evidence.
