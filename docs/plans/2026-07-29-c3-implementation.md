# C3 implementation spec — delegated execution, consent hash, service accounts

**Status:** Binding for phase 7 · **security-critical** · ships behind a flag
**Date:** 2026-07-29
**Implements:** C3 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md) (§2.7, §3)
**Depends on:** C6 ([spec](2026-07-29-c6-implementation.md)) for `resolveWorkflowForCaller` and version ids; C5 for `cost_usd`; C7 for nested-graph closure
**Scope:** `src/extensions/`, `src/db/`, `packages/@ezcorp/sdk/src/runtime/`, `web/src/routes/api/`

> **Citation anchor.** Verified at **`9e41e956`**. Phase 2 is editing
> `src/runtime/workflow-executor.ts` and `src/db/queries/workflow-runs.ts`; C3
> touches neither. `src/extensions/**` is stable. Anchor on the **symbol name**.

**Read §1 first.** It records a conflict between C3's stated purpose and the
existing security argument for why triggering a workflow is not a sensitive
capability. The design record did not surface it, and resolving it is the
central decision of this phase.

---

## 1. The finding the design record missed: `runFor` breaks the not-sensitive argument

### 1.1 The existing argument

`ezcorp:workflows:run` is deliberately **not** in `SENSITIVE_KINDS`
(`src/extensions/capability-types.ts:95-120`), on three stated reasons:

1. **It cannot launder a sensitive capability.** A run registers its own
   non-interactive scope, so any `tool` step needing `shell` / `fs.write` /
   `ezcorp:extension:install` still hits the PDP and fails **closed** — the run
   terminalizes `awaiting_approval` rather than executing. Triggering therefore
   "grants strictly nothing the extension could not already reach" (`:99-106`).
2. **Consent is already collected, per-name, at install** — "an admin approves a
   FIXED, reviewable list of workflows the extension itself ships — not an
   open-ended 'run anything' verb" (`:107-111`).
3. **Always-prompt would make it unusable** for its only purpose (`:112-116`).

And the closing instruction, which this phase is obliged to honour:

> The bound that DOES exist is the per-hour rate limit on the grant… **If a
> future step kind can reach a side effect that is NOT independently PDP-gated,
> revisit this decision first.** (`:118-120`)

### 1.2 What C3 changes

C3's stated purpose includes solving wall 4 — "the extension can trigger a
**user-authored** workflow (the fork)". A forked workflow is by definition
**not** one the extension ships, so its name is not in
`manifest.permissions.workflows.names`, and:

- **rung 4** (manifest allowlist, `workflows-handler.ts:250`) refuses it;
- **rung 5** (grant allowlist, `:256`) refuses it;
- **rung 6** (PDP) refuses it too — `grantsToCapabilitySet` emits **one
  capability per granted name** (`capability-types.ts:788-792`), explicitly so
  that "a boolean would make the PDP's needed↔granted subset check pass for ANY
  name once the extension held the capability at all, which would defeat the
  point of clamping the grant to a specific, admin-reviewed list" (`:783-787`).

So `runFor` cannot reuse `ezcorp:workflows:run` without relaxing exactly the
clamp that reason 2 rests on. **Reason 2 does not survive C3 unchanged.**

### 1.3 Resolution

**A separate capability kind, `ezcorp:workflows:run-delegated`, valued by
`job_ref` — not by workflow name.**

| | `ezcorp:workflows:run` | `ezcorp:workflows:run-delegated` |
|---|---|---|
| Value | bare workflow name | `job_ref` |
| Bound by | admin-approved manifest list | a **delegation row** a human created |
| Reaches | only workflows the extension ships | any workflow **the owner** may run (C6 ladder) |
| Consent | per-name, at install | per-job, at job creation, hash-pinned |

**Reason 1 survives intact and is why this is still not sensitive.** A delegated
run registers the same non-interactive scope; a `tool` step inside it still fails
closed. C3 adds no path to a side effect that is not independently PDP-gated, so
the `capability-types.ts:118-120` trigger condition is **not** met. Phase 7 must
add a comment there recording that this was checked and why the answer held.

**Reason 2 is replaced, not lost.** The admin-reviewed name list is replaced by a
per-job consent record that is *narrower* in every dimension that matters: one
workflow rather than a list, pinned to a definition **version**, bound to a
capability-set hash, revocable, and attached to a named human. The one dimension
where it is *wider* — the workflow need not be extension-shipped — is bounded by
rung D7: **the owner must be able to run it themselves** under C6's ladder.

**Reason 3 is unchanged.** Prompting is structurally impossible for a background
fire, which is the entire point.

This substitution is the single most reviewable decision in C3, and §10 lists it
first among the things to attack.

---

## 2. `workflow_delegations`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `TEXT` PK | no | — |
| `extension_id` | `TEXT` → `extensions(id)` **ON DELETE CASCADE** | no | — |
| `job_ref` | `TEXT` | no | — |
| `owner_kind` | `TEXT` (`'user' \| 'service'`) | no | — |
| `owner_user_id` | `TEXT` → `users(id)` **ON DELETE CASCADE** | yes | — |
| `owner_service_account_id` | `TEXT` → `service_accounts(id)` **ON DELETE CASCADE** | yes | — |
| `workflow_name` | `TEXT` | no | — |
| `definition_version_id` | `TEXT` → `workflow_definition_versions(id)` **ON DELETE RESTRICT** | yes | — |
| `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | — |
| `trigger_kind` | `TEXT` | no | — |
| `trigger_spec` | `JSONB` | yes | — |
| `consent_hash` | `TEXT` | no | — |
| `capability_set` | `JSONB` | no | — |
| `max_cost_cents_per_run` | `INTEGER` | no | — |
| `max_runs_per_day` | `INTEGER` | no | — |
| `consecutive_failures` | `INTEGER` | no | `0` |
| `enabled` | `BOOLEAN` | no | `true` |
| `disabled_reason` | `TEXT` | yes | — |
| `consented_at` | `TIMESTAMPTZ` | no | — |
| `consented_by_user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | no | — |
| `revoked_at` | `TIMESTAMPTZ` | yes | — |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | no | `NOW()` |

### 2.1 Why `CASCADE` on the owner, and why a table at all

The design record originally said `ON DELETE SET NULL → the job auto-disables`.
That is infeasible **and** unsafe:

- **Infeasible** — the job record lives in extension `Storage`
  (`.ezcorp/extension-data/ez-factory/`), not in a table. **There is no FK to
  fire.** Nothing in Postgres can reach it.
- **Unsafe** — `SET NULL` on the column that *is* the authority produces a row
  that is `enabled`, carries a valid `consent_hash`, and names **nobody**: a
  latent ownerless grant, which is precisely the state `-32106` exists to
  prevent.

So the authority lives in a real table with a real FK, and deleting the user
**deletes the authority**. The job's next fire finds no delegation at rung D2 and
is refused; the extension surfaces "disabled: owner removed". Same user-visible
outcome, achieved by the database rather than by hope.

`RESTRICT` on `definition_version_id` is deliberate and differs from every other
FK here — **and it is a constraint C6 must honour; see
[C6 spec §3.4](2026-07-29-c6-implementation.md), which carries the matching
note**: a version row that a live delegation pins must not be reapable by C6's
retention sweep (C6 spec §3.4), or the consent hash would reference a snapshot
that no longer exists.

Exactly one of `owner_user_id` / `owner_service_account_id` is populated per
`owner_kind`. No CHECK constraint — enforce in the query layer, consistent with
the rest of the schema.

### 2.2 Indexes

- `uniq_workflow_delegation ON (extension_id, job_ref) WHERE revoked_at IS NULL` — one live delegation per job; revoked rows accumulate as history.
- `idx_workflow_delegations_owner_user ON (owner_user_id)` and `…_service ON (owner_service_account_id)` — both fire on delete.
- `idx_workflow_delegations_enabled ON (extension_id, enabled) WHERE revoked_at IS NULL` — the rung D2 lookup.

### 2.3 `workflow_runs` additions

| Column | Type | Null | FK |
|---|---|---|---|
| `run_as_kind` | `TEXT` | yes | — |
| `run_as` | `TEXT` | yes | **none — deliberate** |
| `delegation_id` | `TEXT` | yes | → `workflow_delegations(id)` **ON DELETE SET NULL** |

`run_as` is a **plain text snapshot with no FK**: it is the audit record of who a
run executed as and must survive both revocation and owner deletion.
`delegation_id` carries the live FK and goes NULL; `run_as` never does. Same
denormalization rationale as `workflow_runs.workflow_name`.

Index: `idx_workflow_runs_run_as ON (run_as_kind, run_as, started_at DESC)` —
backs the "jobs running as me" page and the D8 daily count.

---

## 3. The consent hash

### 3.1 Inputs (all of them)

`SHA-256` over a **canonically serialized** tuple — sorted keys, no whitespace,
explicit `null`s. A serializer whose output depends on insertion order would make
the hash non-deterministic and suspend every fire.

1. `extensionName` — registry-resolved, never the wire. A delegation cannot be presented by a different extension.
2. `workflowName` — fully qualified (`<ext>:<name>` or the bare DB name).
3. `definitionVersionId` **and** `version` — C6's snapshot. This is what makes the hash cheap: no re-serializing `steps` on every fire.
4. **The computed capability set of the definition** — sorted, deduplicated `{kind, value}` for every step: each `tool` step's declared capabilities resolved through the registry; each `agent` step's `llm:<provider>` plus its tool scope; `gate` / `transform` / `approval` contribute nothing.
5. **The transitive closure of nested workflows** (C7 `kind: "workflow"`) to the depth-3 cap, each contributing its own capability set. Without this, an author consents to a two-step graph and then buries `run_command` in a child.
6. `triggerKind` + canonical `triggerSpec` — the cron expression and timezone, or the webhook key, or the event name and filter. "Runs on every push to `main`" is part of what was authorized.
7. `projectId` and the `runAs` ref (`kind` + id) — a job moved to another project touches different files.
8. The **model-override set** (C1), sorted by step name — a silent re-point from Haiku to Opus is a 30× spend change on the owner's credits.

### 3.2 Deliberately excluded, and why

`input` values, display name, description, concurrency policy. These change
routinely and change nothing about authority. **Hashing them would train users to
click through re-consent, which is its own vulnerability** — a consent dialog
that fires on every typo fix stops being read, and then the one that matters is
not read either.

### 3.3 Recompute and mismatch

Recomputed on **every** `runFor`, immediately before dispatch, from live state —
never read back from the row and compared to itself. The row stores what the
human agreed to; the handler computes what the world says now.

**Invalidated by:** any definition edit (C6 mints a version → new
`steps_hash`); adding/removing/re-pointing a nested workflow; changing the
trigger, project, `runAs`, or model set; the extension narrowing its manifest so
a step's tool is unreachable (the set *shrinks* — still a mismatch, still re-ask,
because the behaviour changed); an extension update that rewrites a shipped
`*.workflow.yaml`.

**On mismatch: suspend, do not fail.** The run is created and immediately
`suspended` with `suspended_reason='consent-stale'`, a `workflow_approvals` row
is written whose prompt is a **capability-set diff** (added capabilities
highlighted), and `ext:workflow-consent-stale` is audited. Only the owner may
re-consent, which updates `consent_hash` and resumes. **Nothing executes in the
interim** — suspension happens before the first step dispatches.

Suspending rather than failing is deliberate: a hard failure trains authors to
disable the check, while a suspension with a legible diff makes the security
control the fastest path to a working job.

---

## 4. The wire carries a job ref, never a user id

This is the strongest property in the design and it deserves to be stated as
such.

`ctx.workflows.runFor(jobRef, name, input)` transmits a **job reference**. There
is **no wire field that names a principal.** The owner is resolved host-side:

```
jobRef ──▶ workflow_delegations(extension_id = <registry-resolved>, job_ref, revoked_at IS NULL)
       ──▶ owner_kind + owner_user_id | owner_service_account_id
```

So "invent an owner" is not *denied* — it is **inexpressible**. There is no
malformed value an attacker can supply, because there is no field for it. A
compromised extension can present only job refs for delegations a human already
created for that extension; a forged ref matches zero rows at D2 and is refused
before anything resolves.

This is the same structural bound namespacing gives workflows
(`workflows-handler.ts:236-243`: the wire carries a bare name, the host applies
the prefix, so a host or foreign workflow name has no representation). Denials
can be bypassed by a bug; **inexpressibility cannot.**

The corollary that must hold for it to be true: **`extension_id` comes from the
registry, never the wire** (as rung 0 already guarantees for every reverse-RPC),
and `project_id` for the run comes from `workflow_delegations.project_id`, never
from params — the same confused-deputy fix `handlePiGithubProjects` documents.

---

## 5. The full ladder

Rungs 1–6 and 8–13 are shared verbatim with `run`; `runFor` replaces rung 7 with
D1–D9. Every outcome, accept and reject, writes `sdk_capability_calls`
(`capability: "workflows"`, `action: "runFor"`) with a typed `errorCode`, via the
existing `audit` helper.

| Rung | Check | Deny code | Audits to |
|---|---|---|---|
| 0 | Provenance from host-issued `ezCallId`; unresolved ⇒ `-32602` | — | log (ERROR) |
| 1 | `EZCORP_DISABLE_CAPABILITY_TOOLS=1` (`workflows-handler.ts:214`) | `WORKFLOWS_DISABLED` | `sdk_capability_calls` |
| 1b | **New** `EZCORP_DISABLE_DELEGATED_WORKFLOWS=1` — C3 alone | `DELEGATION_DISABLED` | `sdk_capability_calls` |
| 2 | Structural grant check (`:221-231`) | `WORKFLOWS_NOT_GRANTED` | `sdk_capability_calls` |
| 2b | **New** `granted.workflows.allowDelegated === true` | `DELEGATION_NOT_GRANTED` | `sdk_capability_calls` |
| 3 | Workflow name bare + `:`-free (`:238`) | `WORKFLOW_NAME_INVALID` | `sdk_capability_calls` |
| 4 | **Skipped for `runFor`** — replaced by D5/D6/D7 (§1.3). The manifest allowlist cannot gate a forked workflow. | — | — |
| 5 | **Skipped for `runFor`** — same reason. | — | — |
| 6 | PDP `authorize` for `{kind:"ezcorp:workflows:run-delegated", value:<jobRef>}` (§1.3) | `WORKFLOWS_PERM_DENIED` | `sdk_capability_calls` |
| **D1** | `jobRef` shape — non-empty string ≤128 chars | `DELEGATION_BAD_REF` | `sdk_capability_calls` |
| **D2** | Delegation lookup on `(extension_id, job_ref, revoked_at IS NULL)`. Absent ⇒ refuse. **Closes "invent an owner" (§4).** | `DELEGATION_NOT_FOUND` | `sdk_capability_calls` |
| **D3** | `enabled = true` | `DELEGATION_DISABLED_ROW` | `sdk_capability_calls` |
| **D4** | **Owner resolution.** `user` ⇒ the `users` row exists and `status='active'`. `service` ⇒ the `service_accounts` row exists and `enabled`. **Audits to `audit_log`, not `sdk_capability_calls`** — the latter's `on_behalf_of` is `NOT NULL` + FK to `users`, so an ownerless row cannot exist there; routing it through `deny()` would produce a swallowed insert and **no trail for exactly the rejection class that most needs one.** Same precedent as rung 7 (`workflows-handler.ts:286-290`). | `DELEGATION_OWNER_UNRESOLVED` | **`audit_log`** (`ext:workflow-delegation-no-owner`, nullable `user_id`) |
| **D5** | Consented `workflow_name` equals the resolved name — a delegation for A cannot run B | `DELEGATION_WORKFLOW_MISMATCH` | `sdk_capability_calls` |
| **D6** | **Consent hash** (§3). Mismatch ⇒ **suspend, not deny** | `DELEGATION_CONSENT_STALE` | both (`ext:workflow-consent-stale`) |
| **D7** | **Owner authorization** — re-run C6's `resolveWorkflowForCaller(name, owner)`. The delegation cannot grant reach the owner lacks. **This is what replaces rungs 4–5.** | `DELEGATION_OWNER_UNAUTHORIZED` | `sdk_capability_calls` |
| **D8** | Per-job daily quota — count `workflow_runs WHERE delegation_id = $1 AND started_at >= startOfUtcDay(now())` against `max_runs_per_day`. **Calendar day, not a rolling window** — reuse `startOfUtcDay` (`src/extensions/webhook-store.ts:92`), which the existing daemon quota already uses. A rolling window is gameable at the edges (§10.3) and two subsystems answering "per day" differently is a permanent support burden. **Durable**, unlike the in-memory hourly window (`:146-160`) — a restart must not reset a spend bound. | `DELEGATION_QUOTA_EXCEEDED` | `sdk_capability_calls` |
| **D9** | Per-job spend cap — sum `workflow_step_runs.cost_usd` (C5) over the window. Re-checked **during** the run at each step boundary; exceeding suspends with `suspended_reason='quota'`. | `DELEGATION_SPEND_EXCEEDED` | `sdk_capability_calls` |
| 8 | Wiring gate when a conversation is present (`:316-321`); a delegated fire normally has none | `WORKFLOWS_NOT_WIRED` | `sdk_capability_calls` |
| 9 | Instantaneous rate limit, 50 ops/s (`:324`) | `WORKFLOWS_RATE_LIMITED` | `sdk_capability_calls` |
| 10 | Payload — `v === 1`, `input` object ≤16KB (`:329-347`) | `WORKFLOWS_BAD_PAYLOAD` | `sdk_capability_calls` |
| 11 | Extension hourly quota (`:350`) | `WORKFLOWS_QUOTA_EXCEEDED` | `sdk_capability_calls` |
| 12 | Resolve against the live cache (`:364-376`) | `WORKFLOW_NOT_FOUND` | `sdk_capability_calls` |
| 13 | Dispatch as the owner, writing `run_as_kind`, `run_as`, `delegation_id` | `WORKFLOWS_DISPATCH_FAILED` | `sdk_capability_calls` |

On dispatch outcome, `consecutive_failures` resets to 0 on `success`, increments
on `error`, and at **5** auto-disables the row with `disabled_reason` and an
audit entry — the same threshold and policy as `AUTO_DISABLE_AFTER`
(`schedule-daemon.ts:87`). Reusing the number matters more than the number.

---

## 6. Service accounts

An **opt-in, admin-created, non-human principal** for org-level jobs whose owner
should not be a person who might leave.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` / `name` (UNIQUE) / `description` | `TEXT` | no | |
| `created_by_user_id` | `TEXT` → `users(id)` **ON DELETE RESTRICT** | no | an admin with live service accounts cannot be hard-deleted |
| `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | a project-scoped account cannot reach another project |
| `scopes` | `JSONB` | no | clamped to the creating admin's scopes at creation |
| `max_cost_cents_per_day` | `INTEGER` | no | mandatory — there is no "unlimited" value |
| `enabled` / `disabled_reason` | `BOOLEAN` / `TEXT` | | |

- **Created only** by an `admin` through a session-authenticated route
  (`POST /api/service-accounts`), never by an extension, never by a `chat`-scoped
  API key. Every creation writes `audit_log`.
- **Cannot log in.** No `users` row, no password hash, no session, no API key. It
  exists solely as a `run_as` target. This is what keeps the blast radius small:
  compromising the identity yields nothing beyond the jobs already delegated to
  it.
- **Scope clamping** to the creating admin closes the "admin mints a principal
  broader than themselves" path. Admins hold every extension RBAC scope today, so
  this bites only once narrower roles exist — write it now, not later.

| | user `runAs` | service account |
|---|---|---|
| Consent | the user, in their own session, per job | an admin once at creation, then per job |
| Credits | the user's provider credentials | the instance's, via the account cap |
| SSE visibility | the owner sees the stream | nobody; observed via trace + audit |
| Dies with | the user (`CASCADE`) | explicit disable only |
| Default | **yes** | opt-in |

The default is a user `runAs` because it is the **narrower, more accountable**
option: a real person is on the hook and the run is visible to them live.
Service accounts trade that visibility for durability.

---

## 7. What is NOT relaxed

- **`-32106` stays in both places** — `provenance.ts` (`resolveReverseRpcMeta`,
  the ownerless refusal) and `workflows-handler.ts:291-311` (rung 7, re-asserted
  so the bound is testable in isolation). `runFor` adds rungs; it removes none.
  A fire presenting no valid delegation still gets `-32106`.
- **Namespacing stays structural** (`:236-243`, `:372`).
- **The manifest re-read stays** for `run` (`:250-253`). `runFor` skips rungs 4–5
  by design (§1.3), and D7 is the replacement bound — not an absence of one.
- **Sensitive-capability steps still fail closed inside the run.** Delegation does
  **not** pre-approve tool consent. This is reason 1 of §1.1 and it is why C3 does
  not trip the `capability-types.ts:118-120` revisit condition.
- **No always-allow row is ever written** on the owner's behalf.
- **Extensions cannot write delegations.** No reverse-RPC creates, edits, or
  re-consents one.

---

## 8. Threat model

| # | Attacker | Attempt | Rung | Test |
|---|---|---|---|---|
| T1 | Malicious extension | `runFor` naming an arbitrary user | **§4 — inexpressible.** No wire field names a principal; a forged `jobRef` matches zero rows at D2 | `"a forged job ref resolves no delegation and is refused"` |
| T2 | Malicious extension | Write its own delegation | No reverse-RPC creates one; the route is session-authenticated | `"no RPC surface can create a delegation"` (asserts the handler has no create path) |
| T3 | Malicious extension | Present another extension's delegation | D2 keys on registry-resolved `extension_id` | `"a delegation is invisible to a second extension"` |
| T4 | Malicious workflow author | Consent to a harmless graph, then add `run_command` | D6 — capability set is a hash input (§3.1 #4) | `"adding a tool step invalidates the consent hash"` |
| T5 | Malicious workflow author | Bury capability in a **nested** workflow | D6 — transitive closure (§3.1 #5) | `"a nested-workflow edit invalidates the root hash"` |
| T6 | Compromised webhook sender | Flood the job to burn credits | D8 + D9 + extension hourly quota + auto-disable | `"per-job daily quota trips before the extension quota"` |
| T7 | Compromised webhook sender | Steer an agent step via `input` | 16KB cap (`:95`); `input` is deliberately **not** hashed (§3.2) — the capability set, not the input, decides what the run may do | `"oversize input is refused"` + a prompt-hygiene test |
| T8 | User narrower than the owner | Edit the job, then trigger it | D6 — trigger/project/`runAs`/model are hash inputs (§3.1 #6–8); re-consent requires a session **as the owner** | `"a non-owner cannot re-consent a stale delegation"` |
| T9 | User narrower than the owner | Read the run's output | SSE scoped to the owner; C5's run route applies C6's ladder | `"a non-owner cannot read a delegated run's trace"` |
| T10 | Admin | Mint a service account broader than themselves | §6 scope clamping | `"service-account scopes clamp to the creator's"` |
| T11 | Anyone | Replay a delegation after the manifest narrowed | D6 — the capability set shrinks, which is still a mismatch (§3.3) | `"a narrowed manifest invalidates the hash"` |
| T12 | Anyone | Use a delegation whose owner was deleted | `CASCADE` (§2.1) deleted the row; D2 refuses | `"deleting the owner deletes the delegation"` |

---

## 9. Migration, tests, build order

### 9.1 Migration

Ordered — `service_accounts` first (FK target), then `workflow_delegations`, then
the `workflow_runs` columns.

1. `CREATE TABLE IF NOT EXISTS service_accounts (…)` + `uniq_service_account_name`
2. `CREATE TABLE IF NOT EXISTS workflow_delegations (…)` + the three indexes (§2.2)
3. `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS run_as_kind TEXT`
4. `… ADD COLUMN IF NOT EXISTS run_as TEXT`
5. `… ADD COLUMN IF NOT EXISTS delegation_id TEXT REFERENCES workflow_delegations(id) ON DELETE SET NULL`
6. `CREATE INDEX IF NOT EXISTS idx_workflow_runs_run_as ON workflow_runs(run_as_kind, run_as, started_at DESC)`

**No backfill** — every column is meaningless for pre-C3 runs and NULL is the
honest value. All additive; nothing existing changes shape.

### 9.2 Tests

New files → threshold keys (all 100): `src/db/queries/workflow-delegations.ts`,
`src/db/queries/service-accounts.ts`, `src/runtime/workflow-capability-hash.ts`,
the delegation and service-account routes.

- **One test per rung**, including every deny code, and **both audit
  destinations** asserted separately (D4 → `audit_log`; the rest →
  `sdk_capability_calls`).
- **Hash determinism** under key reordering; **each of the 8 inputs individually
  invalidating**; **each of the 4 exclusions individually NOT invalidating**
  (§3.2 — this is the test that protects users from click-through fatigue).
- **T1–T12 as named cases.**
- **D9 mid-run:** exceeding the cap at a step boundary suspends rather than
  completing.
- **Flag off ⇒ byte-identical.** With `allowDelegated` absent and the kill switch
  engaged, every existing `ezcorp/workflows` test passes unmodified.

### 9.3 Build order

| # | Land | Why here |
|---|---|---|
| 1 | Migration + schema. No behaviour. | Additive, provable alone. |
| 2 | `service_accounts` + its admin route + scope clamping. | Independent of delegation; the narrower half first. |
| 3 | `workflow-capability-hash.ts` — pure, no I/O. | The hash is the security core; test it in isolation before anything consumes it. |
| 4 | Delegation CRUD queries + the session-authenticated consent route. | Rows exist before anything reads them. |
| 5 | `ezcorp:workflows:run-delegated` capability + clamp + the `capability-types.ts` comment (§1.3). | The §1 decision, landed explicitly and reviewably. |
| 6 | `runFor` handler — D1–D9 — behind the flag, default **off**. | The ladder, on a hash and rows already proven. |
| 7 | SDK `ctx.workflows.runFor`. | |
| 8 | Consent dialog + capability diff + "jobs running as me" page. | `@evidence`. |
| 9 | D9's per-step-boundary re-check in the runner. | Needs C4's boundary hook. |

---

## 10. What a reviewer should attack first

Three genuinely weak points in this design, named honestly.

### 10.1 Skipping rungs 4–5 is the largest single concession — attack it here

`runFor` deliberately bypasses the manifest and grant allowlists (§1.3), which
are the bounds reason 2 of the not-sensitive argument rests on
(`capability-types.ts:107-111`). Everything now rests on **D7** — "the owner
could run it themselves" — and D7 is only as strong as C6's
`resolveWorkflowForCaller`, which **does not exist yet**.

If C6's ladder has a gap, C3 inherits it directly, and the failure mode is an
extension running a workflow the owner should not have reached. **The right
attack:** find a workflow a user can *see* but should not be able to *run*, and
check whether C6's resolver distinguishes those. If it collapses read and run
into one check, C3 is wider than it looks.

### 10.2 The capability set is computed, and a wrong computation is silent

D6 hashes a **computed** capability set (§3.1 #4–5). If the computation
under-reports — a tool whose capabilities are declared dynamically, a step kind
added later that reaches a side effect without registering a capability, an
extension whose manifest is edited between computation and dispatch — then the
hash matches, consent looks fresh, and **the run executes with authority the
human never saw.** There is no runtime cross-check that the executed run stayed
within the hashed set.

Mitigation as specced is weak: it relies on every future step kind remembering to
contribute to the closure. **The right attack:** add a step kind and see whether
the hash notices.

> ### DEFERRED — the durable fix, and the first thing to build if C3 is revisited
> **The computed hash is an interim mechanism with a known failure direction: it
> fails toward MORE authority, silently.** Under-reporting produces a matching
> hash, a fresh-looking consent, and a run executing with capability the human
> never saw — every visible signal says the control is working.
>
> The durable fix is to make the guarantee **dynamic rather than predictive**:
> verify the **actual** capability set at each step boundary against the hashed
> one, and **suspend on divergence** (the boundary hook C4 already introduces).
> Prediction becomes an optimization rather than the security property.
>
> This is deliberately out of scope for phase 7 — it depends on C4's boundary
> hook being load-bearing for a second consumer, and it is a larger change than
> the rest of C3. **It is recorded here so it does not become folklore.** If C3
> is ever reopened, build this first.

### 10.3 The 24-hour quota window was rolling and gameable · **RESOLVED — aligned to `startOfUtcDay`**

> **Decided 2026-07-29:** D8 uses `startOfUtcDay` (`webhook-store.ts:92`), the
> same calendar-day boundary the existing daemon quota uses. The analysis below
> is retained as the reason. This is no longer an open weakness; it is recorded
> so nobody re-derives the rolling window as an "obvious" simplification.

As originally specced, D8 counted `started_at > now() - 24h`. A job at the cap could fire again the instant
the oldest run ages out, so a `max_runs_per_day: 10` job can execute 20 runs in a
~24-hour span straddling the boundary. For a spend bound that is probably
acceptable; for a job with expensive `agent` steps it is a 2× overrun of a limit
the owner believed was absolute.

The daemon's own quota uses a **UTC-day** boundary (`startOfUtcDay`,
`webhook-store.ts:92`), which is not gameable this way, and having C3 and the
daemon answer "per day" differently would be exactly the kind of divergence that
outlives everyone involved. **Resolution: use the existing helper.**

---

## 11. Acceptance criteria

Falsifiable — a named test or a grep per row. **A floor, not a ceiling**; §11.1
is what the rows cannot cover.

| # | Criterion | Proven by |
|---|---|---|
| **P1** | **PRECONDITION — do not start phase 7 until this holds.** C6's `resolveWorkflowForCaller` demonstrably **distinguishes read from run**: a workflow a caller may *see* but not *run* must fail D7. If C6 collapses the two into one check, C3 inherits the gap directly (§10.1). | A C6 test asserting a visible-but-unrunnable workflow is denied at run; re-asserted from C3's side with the resolver as the seam. |
| **P2** | **MANDATORY — the `capability-types.ts:118-120` revisit condition was checked and the answer recorded in that file.** A comment naming the check, the reason it held (tool steps inside a delegated run still hit the PDP under the non-interactive scope and still fail closed), and the phase that checked it. A future reader must not have to re-derive it. | Grep: `capability-types.ts` contains the comment adjacent to the standing instruction. The build cannot land without it. |
| 1 | No wire field names a principal (§4). | Grep: the `runFor` params type has no user/owner field. A test asserting a forged `jobRef` resolves nothing. |
| 2 | `-32106` is unchanged in both sites (§7). | Grep both call sites; the existing ownerless tests pass unmodified. |
| 3 | D4 audits to `audit_log`, every other rung to `sdk_capability_calls`. | Asserted per-destination, not merely "an audit row was written". |
| 4 | All 8 hash inputs invalidate; all 4 exclusions do not (§3.1, §3.2). | Twelve named cases. |
| 5 | Consent mismatch **suspends**, never fails, and nothing dispatched. | A test asserting `status='suspended'`, a `workflow_approvals` row, and **zero** step rows. |
| 6 | D7 re-runs C6's resolver as the **owner**, not the caller. | A spy asserting the resolver received the owner id. |
| 7 | Flag off ⇒ byte-identical. | Every existing `ezcorp/workflows` test passes unmodified with the flag off. |
| 8 | Service accounts cannot authenticate. | Grep: no `users` row is created; a test asserting login/API-key issuance is impossible for one. |
| 9 | Delegated runs still fail closed on sensitive tool steps (reason 1, §1.1). | A delegated run containing a `shell` tool step terminalizes `awaiting_approval`. |

### 11.1 Beyond the checklist

- **Interactions:** D6 (consent) and D9 (spend) both suspend. Verify a run
  suspended for `quota` cannot be resumed by answering a **consent** approval —
  two suspension reasons, one resume path, and the wrong pairing silently
  bypasses a spend cap.
- **Migration extensibility:** can a third `owner_kind` (a team? a project?) be
  added without a destructive change? The two nullable owner FKs suggest yes;
  verify the query layer does not switch on a two-value union.
- **Meaningless coverage:** the ladder tests must assert **which** deny code and
  **which** audit destination, not that a rejection occurred.
- **Untested by default:** a delegation revoked mid-run; an owner deleted between
  D4 and dispatch; two `runFor` calls racing on the same `jobRef` at the daily
  cap boundary; a service account disabled while one of its runs is suspended.

**And the standing one:** anything here the build proves wrong. §1 already
records a conflict the design record missed — a second is a better outcome than
a spec defended past its evidence.
