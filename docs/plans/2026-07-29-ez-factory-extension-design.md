# ez-factory — phase 8 extension design

**Status:** Binding for phase 8
**Date:** 2026-07-29
**Implements:** §6 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Depends on:** C1 (landed), C4, C5, C7, C2, C6, C3 — see §7 for what is demoable when
**Scope:** `extensions/ez-factory/` (bundled) — no core changes

> **Citation anchor.** Verified at **`cf8c3222`**. This design touches no core
> files; every citation is a *read* of a stable SDK or host surface.

**§1 is the reason this document exists.** Three things the SDK cannot do that
the plan assumed it could. One of them changes `run_command`'s security model
entirely.

---

## 1. What the SDK cannot do

### 1.1 There is no shell surface — and it is why `run_command` is CUT from v1 · **the important one**

The plan describes `run_command` as a "jailed shell: allowlist, cwd bound,
timeout, output cap, secret redaction", implying the host enforces those. **It
does not.** There is no `ctx.shell`, no `ezcorp/shell` reverse-RPC, and no
`shell.ts` in `packages/@ezcorp/sdk/src/runtime/` at all.

What `permissions.shell: true` actually does is **un-poison the raw primitive**.
`sandbox-preload.ts:177-190`:

```ts
if (!shellAllowed) {
  for (const mod of SHELL_MODULES) { poisonModule(mod, "shell"); … }
  BunNs.spawn     = makeDenier("shell", "Bun.spawn");
  BunNs.spawnSync = makeDenier("shell", "Bun.spawnSync");
  BunNs.$         = makeDenier("shell", "Bun.$");
}
```

Granted ⇒ the guard is skipped and `Bun.spawn` is the real one. **The host never
sees the argv, the cwd, the timeout, or the output.** Every bound in
`run_command`'s envelope is self-imposed extension code that the host does not
verify and cannot enforce.

This is exactly how `ez-code-factory` works today — `productionHostRunner`
(`lib/shell.ts:53`) is a bare `Bun.spawn`, and its own comment says subprocesses
"run OUTSIDE the sandbox preload's poisoning, so this is the supported way to
touch git + the filesystem from extension code."

**Decision (2026-07-29): `run_command` is cut from v1.**

`permissions.shell: true` is the whole grant — an admin approving it approves
arbitrary command execution, not a bounded runner, and every bound would be a
promise verifiable only by reading the extension's source. Weigh that against the
fact that **neither v1 template needs it**: `docs-factory` reads, drafts,
validates and writes; `etl-factory` (§6.2, now filesystem-based) does the same.
Nothing in v1 runs a command.

Shipping an unbounded arbitrary-execution grant to enable zero v1 functionality
is a bad trade, and a worse one for an extension whose premise is "anyone can
install this and build factories" — the install prompt would read *"this
extension may run arbitrary commands"* for a docs generator.

`run_command` returns **with the git template**, post-v1, where it earns the
grant and gets the full jail treatment. **Ported invariants 9, 10 and 11 defer
with it** (design record §4), consistent with the git-specific invariants 1, 3
and 4 already deferred. Phase 9 must not expect them.

### 1.2 fs is the opposite posture — always mediated, never raw

`sandbox-preload.ts:193-195` is explicit:

> Phase 3: fs primitives are **ALWAYS** poisoned in the subprocess — granted
> access does **NOT** unblock raw in-sandbox primitives. All IO flows through
> `ezcorp/fs.{read,write,list,stat,exists,mkdir,unlink}`.

So `read_files` and `write_file` are genuinely host-bounded: `fsRead`
(`fs.ts:203`) and `fsWrite` (`:228`) are reverse-RPCs, path-checked host-side
against the filesystem grant. **`write_file` is the safe tool; `run_command` is
the dangerous one**, and the asymmetry is structural rather than a matter of
care.

Stating it plainly because it inverts the intuition: a tool that writes files is
*more* contained than a tool that runs commands, even though writing files sounds
scarier.

### 1.3 There is no glob, and `fsList` is not recursive

`read_files` is specced as "glob + read within the project". Neither half of the
mechanism exists:

- No glob helper in `fs.ts` (the only `glob` hit is an unrelated comment at
  `:253` about `Buffer`).
- `Bun.Glob().scan()` walks the filesystem with **raw fs**, which is poisoned
  unconditionally (§1.2) — so it throws inside the subprocess.
- `fsList` (`fs.ts:281`) is **single-directory**: it returns
  `{ name, isFile, isDirectory }` with no path and no recursion.

So `read_files` must **recursively `fsList` and match in-process** — one
reverse-RPC round-trip per directory. `Bun.Glob` is still usable for *pattern
matching against strings* (`.match()`), just not for scanning. §3.2 specifies a
depth cap and a directory-visit budget, because the cost is per-directory RPC
rather than a local walk.

---

## 2. Manifest

```ts
export default defineExtension({
  name: "ez-factory",
  version: "1.0.0",
  description: "Build and run declarative jobs — code, docs, and data factories.",
  permissions: {
    storage: true,
    triggers: { maxCron: 25, maxWebhooks: 25, webhookPrefix: "factory-", maxRunsPerDay: 500 },
    workflows: {
      names: ["docs-factory", "etl-factory", "draft-and-verify"],
      maxRunsPerHour: 60,
      allowDelegated: true,
    },
    llm: {
      providers: ["anthropic"],
      allowedModels: { anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"] },
      maxCostCentsPerDay: 500,
    },
    filesystem: ["$CWD"],
    rbacScopes: [
      { name: "manage-jobs",  description: "Create, edit, enable/disable, delete jobs" },
      { name: "run-job",      description: "Fire a job manually" },
      { name: "approve-gate", description: "Answer a parked approval step" },
    ],
    eventSubscriptions: ["workflow:complete", "workflow:error"],
  },
  pages: [{ id: "factory", … }, { id: "job", … }],
});
```

### 2.1 Justification, permission by permission

| Permission | Why | Dropped if not justified |
|---|---|---|
| `storage: true` | The job model lives here (§2). No alternative — extensions have no table. | Required |
| `triggers` | The entire point (C2). `maxCron/maxWebhooks: 25` matches the plan; `webhookPrefix` is a manifest-only namespace claim (C2 spec §2.1). | Required |
| `workflows` | `names` are the three shipped assets; `allowDelegated` is what makes a background job able to run one at all (C3). `maxRunsPerHour: 60` bounds LLM spend. | Required |
| `llm` | The three agents. `allowedModels` enumerated so a step cannot silently pick an unbudgeted model; `maxCostCentsPerDay: 500` is the hard spend bound. | Required |
| **`shell`** | **DROPPED.** It was needed only by `run_command`, which is cut (§1.1). `permissions.shell` un-poisons raw `Bun.spawn` with **no host enforcement** — an unbounded arbitrary-execution grant. Neither v1 template runs a command, so v1 requests it not at all. | **Dropped** |
| `filesystem: ["$CWD"]` | `read_files`, `write_file`, `emit_artifact`. Project-scoped. | Required |
| `rbacScopes` | Three-way least privilege: `run-job` ⊄ `manage-jobs` ⊄ `approve-gate`. Ported invariant 18. | Required |
| `eventSubscriptions` | The console shows live run status without polling. Two direct-carrier events only. | Required |
| **`network`** | **DROPPED.** `http_fetch` is cut (§4.4). The grant belongs to the *extension*, not the workflow, so a user forking a template cannot widen it — the tool could never work for its stated purpose. `["*"]` would be an SSRF grant no review should pass. | **Dropped** |
| `settings` | Not needed — no instance-wide config in v1. | **Dropped** |
| `secrets` | Not needed in v1 (no `gh` token; the git template is deferred). | **Dropped** |

**Pages: 2 of the 3-permitted** (`docs/extensions/pages.md:31` —
"Max **3 pages** per extension, enforced at install"). The third is deliberately
left unclaimed: run traces link out to core's `/workflows/runs/[id]` rather than
being re-implemented, which is the whole point of C5.

---

## 3. The job model in `Storage`

### 3.1 Shape

```ts
interface FactoryJob {
  id: string;                       // ULID-ish, stable
  name: string;
  description: string;
  projectId: string;
  workflow: string;                 // "ez-factory:docs-factory" | a forked bare name
  input: Record<string, unknown>;
  modelOverrides: Record<string, { provider?: string; model?: string; effort?: ModelEffort }>;
  trigger:
    | { kind: "manual" }
    | { kind: "cron"; cron: string; timezone: string }
    | { kind: "webhook" }           // slug is host-minted; read from triggerState
    | { kind: "event"; event: string; filter?: Record<string, unknown> }
    | { kind: "workflow"; onWorkflow: string; onStatus: string[] };
  runAs: { kind: "user" | "service"; id: string };
  consentHash: string;              // C3
  concurrency: { maxConcurrent: number; onConflict: "queue" | "supersede" | "drop" };
  idempotencyKey?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 Key layout — per-key, never one packed array

```
job:<id>            → FactoryJob                 (one key per job)
job-index           → { ids: string[], updatedAt }
run:<jobId>:<runId> → { workflowRunId, status, startedAt, finishedAt?, cost? }
run-index:<jobId>   → { runIds: string[] }       (capped, newest-first)
meta                → { version: 1, migratedAt }
trigger:<jobId>     → { key, kind, slug?, url? }  (C2 registration echo)
```

**One key per job and per run — never a single packed array.** This is not
stylistic: `src/extensions/CLAUDE.md` records that a packed read-modify-write
raced and lost state in `task-tracking`, `ez-code` **and** `ez-code-factory`.
The subprocess channel dispatches inbound frames fire-and-forget, so two
`tools/call` frames interleave and the second `set` silently discards the first's
mutation. Symptom: state that lags or reverts, never an error.

**Every mutation runs inside `withLock(key, …)`** — binding per that same file.
The index keys are the residual risk (they *are* shared), so:

- `job-index` is written under `withLock("job-index")`, and it holds **ids only**
  — never denormalized job fields, so a lost update costs at most a missing list
  entry, recoverable by a repair sweep, rather than corrupt job data.
- `run-index:<jobId>` is per-job, so concurrent runs of *different* jobs never
  contend.

### 3.3 Retention and idempotency

- `run:*` keys capped at **50 per job**, newest-first; the trim happens in the
  same `withLock` as the append. Full history lives in core's `workflow_runs`
  (C5), so the extension's copy is a fast index, not the record.
- `idempotencyKey` threads to `POST …/run`'s key (C4) so a webhook redelivery
  does not double-fire. Default: `<jobId>:<sha256(body).slice(0,16)>` for webhook
  triggers, absent for manual.
- **`meta.version`** exists so a v2 layout can migrate; v1 writes it and reads it
  defensively.

---

## 4. The tools — three shipped, two cut

### 4.1 `run_command` — **CUT from v1, deferred with the git template**

Not shipped. See §1.1 for the reasoning: the SDK provides no mediated shell, so
`permissions.shell` is an unbounded grant with no host enforcement, and neither
v1 template needs it. `ez-factory` v1 therefore declares **no `shell`
permission at all**.

When it returns with the git template it must carry, in one chokepoint with no
second `Bun.spawn` path anywhere in the extension: argv-array-only (never
`sh -c`), an allowlist on `command[0]`, a realpath-checked cwd bound, the
**mandatory** nested jail assembled from `EZCORP_SANDBOX_TIER` +
`EZCORP_SANDBOX_SHIM` with `jailed: false` surfaced when unavailable, fail-safe
path widening, a hermetic non-interactive env (missing binary ⇒ exit 127, never
a throw), timeout + output caps, and secret redaction — i.e. ported invariants
9, 10 and 11.

### 4.2 `read_files`

```ts
input:  { globs: string[], maxBytes?: number, maxFiles?: number }
output: { files: { path: string, content: string, truncated: boolean }[], skipped: string[] }
```

Given §1.3: recursive `fsList` walk + in-process `Bun.Glob().match()` on the
assembled relative path. Bounds: **depth ≤ 8**, **≤ 500 directories visited**,
**≤ 100 files**, **≤ 256 KB per file**, **≤ 4 MB total**. Exceeding any bound
truncates and reports in `skipped` rather than erroring — a partial read is
useful, a thrown tool is not.

Path traversal is host-enforced by the filesystem grant (§1.2), so the tool's own
check is defence-in-depth, not the boundary.

### 4.3 `write_file`

```ts
input:  { path: string, content: string, ifMatch?: string }
output: { path: string, bytes: number, sha256: string }
```

`fsWrite` (`fs.ts:228`) — host-mediated and grant-checked. `ifMatch` is an
optional sha256 precondition so a workflow that read-then-writes can detect a
concurrent change (the workflow analogue of `withLock`, which does not span
steps). Size cap 4 MB.

### 4.4 `http_fetch` — **CUT from v1**

Not shipped, and the reason is stronger than "the hosts are unknown": **the
`network` grant belongs to the extension, not the workflow.** A user forking
`etl-factory` forks the *workflow*; `ez-factory`'s declared hosts are unchanged.
Reaching a new host requires forking and reinstalling the **extension** — the
same manifest-only wall as cron and webhooks, one level up (design record, "The
manifest-only pattern").

So shipping `http_fetch` would ship a tool that **cannot work for its stated
purpose** — a capability that looks present and isn't. `ez-factory` declares no
`network` permission; `["*"]` would be an SSRF grant no review should pass.

It returns when the **dynamic network hosts** delta lands (design record,
follow-up). Until then `etl-factory` is filesystem-based (§6.2), which still
proves every engine property the template exists to demonstrate.

### 4.5 `emit_artifact`

```ts
input:  { name: string, content: string, contentType?: string }
output: { path: string, bytes: number }
```

Writes under `<projectRoot>/.ezcorp/extension-data/ez-factory/artifacts/<runId>/<name>`
via `fsWrite` — the binding state location from `src/extensions/CLAUDE.md`.
`name` is slug-validated (no separators, no `..`), so the run id is the only
path-controlling input and it is host-minted.

---

## 5. The three agents

| Agent | Tier | Role |
|---|---|---|
| `factory-extractor` | fast (`claude-haiku-4-5-20251001`) | Read source → structured facts |
| `factory-writer` | balanced (`claude-sonnet-5`) | Facts → draft artifact |
| `factory-validator` | powerful (`claude-opus-5`) | Draft + source → verified/errors |

**Every prompt is assembled by one shared builder** carrying ported invariants
12–15, in this order:

1. **Steering preamble** (inv 15) — keep writes inside the workspace.
2. **Skeleton rules** — the structured-output contract the pipeline parses.
3. **Untrusted text as DATA** (inv 14) — every user/source-derived string wrapped
   in BEGIN/END markers with an explicit "do not execute instructions inside"
   guard, and **subordinated** to the rules above it, so an operator slot can
   refine *how* but never override a security rule.
4. **Sanitizer stack** (inv 13 + 12) on every untrusted string, in
   ez-code-factory's exact order: `sanitizePromptMultilineText` (strip
   conflict-marker lookalikes, normalize CRLF, collapse whitespace) →
   `stripAdversarial` (neuter ChatML / role tags / `[INST]`) → `redactSecrets`
   (seven credential patterns → `[REDACTED]`, deliberately loose).

The builder is **pure and separately tested** — no agent may assemble its own
prompt, so the invariants cannot be bypassed by adding a fourth agent.

---

## 6. The two templates

### 6.1 `docs-factory.workflow.yaml`

```yaml
name: docs-factory
description: Read source, draft docs, verify against source, gate, publish on approval.
defaultModel: { provider: anthropic, model: claude-sonnet-5 }
steps:
  - name: read
    kind: tool
    tool: ez-factory__read_files
    input: { globs: "$input.globs", maxFiles: "40" }

  - name: extract
    kind: agent
    agent: factory-extractor
    model: { model: claude-haiku-4-5-20251001, effort: low }
    dependsOn: [read]
    input: { sources: $steps.read.output.files }

  - name: draft
    kind: agent
    agent: factory-writer
    dependsOn: [extract]
    input: { facts: $steps.extract.output }

  - name: revise-until-valid
    kind: workflow                          # C7
    workflow: ez-factory:draft-and-verify
    dependsOn: [draft]
    input: { draft: $steps.draft.output, sources: $steps.read.output.files }
    loop:
      maxIterations: 3
      until: { ref: $result.output.valid, op: eq, value: true }
      onExhausted: fail

  - name: verified
    kind: gate
    dependsOn: [revise-until-valid]
    condition: { ref: $steps.revise-until-valid.output.valid, op: eq, value: true }

  - name: publish-gate
    kind: approval                          # C4
    dependsOn: [verified]
    prompt: "Publish {{ $steps.revise-until-valid.output.path }}?"
    choices: [approve, revise, abort]
    rbacScope: approve-gate
    requireItemConsent: true
    timeoutMs: 86400000
    onTimeout: abort

  - name: write
    kind: tool
    tool: ez-factory__write_file
    dependsOn: [publish-gate]
    when: { ref: $steps.publish-gate.output.choice, op: eq, value: approve }   # C7
    input: { path: "$input.outPath", content: $steps.revise-until-valid.output.content }

  - name: artifact
    kind: tool
    tool: ez-factory__emit_artifact
    dependsOn: [write]
    input: { name: "docs-run.json", content: $steps.write.output }
```

**Requires:** C1 (landed) · C4 `approval` · C7 `workflow` + `loop` + `when`.
**Runnable from phase 4.**

### 6.2 `etl-factory.workflow.yaml` — filesystem-based

Reads a dropped data file rather than fetching, since `http_fetch` is cut (§4.4).
This still exercises **every engine property the template exists to prove** —
deterministic transform, a schema gate, per-step models, and a conditional
approval that clean runs skip — and it still proves the engine is not
code-specific, which was the point of choosing ETL.

```yaml
name: etl-factory
description: Ingest a data file, reshape it, gate on schema, ask a human only if anomalies appear.
steps:
  - name: ingest
    kind: tool
    tool: ez-factory__read_files
    input: { globs: "$input.globs", maxFiles: "5" }

  - name: transform
    kind: transform
    dependsOn: [ingest]
    output:
      rows: "$steps.ingest.output.files"
      ingestedAt: "{{ $input.now }}"

  - name: schema-ok
    kind: gate
    dependsOn: [transform]
    condition: { ref: $steps.transform.output.rows, op: exists }

  - name: classify
    kind: agent
    agent: factory-extractor
    model: { model: claude-haiku-4-5-20251001, effort: minimal }
    dependsOn: [schema-ok]
    input: { rows: $steps.transform.output.rows }

  - name: anomaly-gate
    kind: approval
    dependsOn: [classify]
    when: { ref: $steps.classify.output.anomalyCount, op: gt, value: 0 }   # clean runs never ask
    prompt: "{{ $steps.classify.output.anomalyCount }} anomalies — proceed?"
    choices: [approve, abort]
    rbacScope: approve-gate

  - name: write
    kind: tool
    tool: ez-factory__write_file
    dependsOn: [anomaly-gate]
    when: { ref: $steps.anomaly-gate.output.choice, op: neq, value: abort }
    input: { path: "$input.outPath", content: $steps.transform.output.rows }

  - name: artifact
    kind: tool
    tool: ez-factory__emit_artifact
    dependsOn: [write]
    input: { name: "etl-run.json", content: $steps.write.output }
```

**Requires:** C4 `approval` · C7 `when`. **Runnable in full from phase 4** — with
`http_fetch` gone, nothing in this template is blocked on a permission the
extension cannot hold.

### 6.3 `draft-and-verify.workflow.yaml`

The sub-workflow `docs-factory` loops over: `factory-writer` revise →
`factory-validator` verify → gate. Kept separate so the loop wraps a *graph*, not
a raw side-effecting step — the bound C7 preserves deliberately.

---

## 7. What phase 8 can demo, phase by phase

| After | `ez-factory` can demo | Cannot yet |
|---|---|---|
| **1** (C1, landed) | Nothing — the extension does not exist | — |
| **2** (C4) | A manual job running `etl-factory` minus `when`; an approval parking and resuming | conditional skip, sub-workflow loops |
| **3** (C5) | The console linking to a real run trace with per-step cost | — |
| **4** (C7) | **Both templates end-to-end, manually triggered** — and with `http_fetch` cut, `etl-factory` now needs no host grant, so both run complete. The strongest pre-C3 demo | any automatic trigger |
| **5** (C2) | Creating cron/webhook triggers; the trigger fires and the handler runs | **the handler cannot run a workflow — `-32106`** (C2 spec §1.5) |
| **6** (C6) | Forking a template into an editable project-scoped copy | — |
| **7** (C3) | **The real product**: a cron job running a workflow as its consenting owner | — |

**The honest summary: phase 8's headline demo — "a job that fires on a schedule
and produces a document" — is not possible until phase 7.** Phases 2–6 each
deliver a real, demoable slice, but every one of them is manually triggered.
Anyone planning a demo before phase 7 should plan a *manual* one.

---

## 8. The two Hub pages

Validated node kinds only — `section`, `heading`, `markdown`, `stats`, `table`,
`button`, `link`, `empty-state`, `form` (`src/extensions/page-schema.ts:770-778`).

**`factory` (console)** — `?view=` multiplexes: jobs `table` (name, trigger,
last run, next fire, spend, enable `button`); templates `section` with a **Fork**
`button` per template; recent runs `table` whose run column is a `link` to core's
`/workflows/runs/[id]`; approvals inbox `table` with approve/abort `button`s
(gated on `approve-gate`).

**`job` (editor)** — one inline `form`: name, workflow select, trigger kind
select with kind-specific fields (`visibleWhen`, so a hidden field is omitted
rather than cleared — the `ez-code-factory` job-editor lesson), per-step model
`table`, input fields, `runAs`, concurrency, enable toggle. **One Save, one
audited diff.**

**Run traces are never re-implemented.** The extension renders a `link`; C5 owns
the trace. That is the whole reason C5 is in core.

---

## 9. Test plan and acceptance criteria

**Coverage:** every `extensions/ez-factory/**` file → 100 in
`scripts/coverage-thresholds.json`. The prompt builder, the three shipped tools, the job
store and the page builders are all pure or injectable-seam.

**E2E:** `ez-factory-console.spec.ts` (`@evidence`),
`ez-factory-job-editor.spec.ts` (`@evidence`), `ez-factory-templates.spec.ts`.

### Acceptance criteria — falsifiable

| # | Criterion | Proven by |
|---|---|---|
| 1 | **Zero `Bun.spawn` call sites, and no `shell` permission in the manifest** (§1.1, §4.1). | Grep for both. v1 requests no unbounded capability; a spawn appearing later must fail this. |
| 2 | **No `network` permission, and no `http_fetch` tool** (§4.4). | Grep. Shipping either would be a capability that looks present and isn't. |
| 3 | Every tool reaches the filesystem **only** via `ezcorp/fs.*`, never a raw primitive (§1.2). | Grep for `node:fs` / `Bun.file` in extension source. |
| 4 | Every agent prompt passes the shared builder; no agent assembles its own. | Spy call-count, mirroring ported invariant 7's chokepoint pattern. |
| 5 | The sanitizer stack runs in order and redacts (§5). | A prompt containing `sk-…`, `<\|im_start\|>` and `<<<<<<<` emerges clean. |
| 6 | Every job mutation is inside `withLock`, and no packed-array write exists. | Grep for `storage.set` outside a lock; concurrent-write test asserting no lost update. |
| 7 | `read_files` respects all five bounds and reports `skipped` rather than throwing (§4.2). | Named test per bound. |
| 8 | `emit_artifact` writes only under `.ezcorp/extension-data/ez-factory/`. | Traversal attempt via `name` is rejected. |
| 9 | Two pages, not three. | Install-time validation (`pages.md:31`). |

### 9.1 Beyond the checklist

- **Interactions:** `run_command`'s redaction (§4.1 #7) and `emit_artifact`
  (§4.5) both handle tool output; verify a command's secret-bearing stdout stays
  redacted when it is *later* written as an artifact — two independently-correct
  redactions with a gap between them is the §11.1 shape.
- **Migration:** can a v2 job shape be read by v1 code without data loss?
  `meta.version` exists; verify the reader actually branches on it.
- **Meaningless coverage:** the tool tests must assert the **envelope** (rejected
  input, applied cap), not that the happy path returned.
- **Untested by default:** two jobs firing the same workflow concurrently under
  `onConflict: supersede`; a job whose `runAs` owner is deleted between fire and
  dispatch; an artifact write racing a run-index trim.

---

## 10. Decisions taken (2026-07-29)

1. **`http_fetch`: CUT.** The `network` grant belongs to the extension, not the
   workflow, so "fork and declare your hosts" means forking and reinstalling the
   *extension* — the same manifest-only wall. Shipping it would ship a capability
   that looks present and isn't. `etl-factory` is filesystem-based instead
   (§6.2). Returns with the **dynamic network hosts** follow-up delta.
2. **`run_command`: CUT.** `permissions.shell` is unbounded with no host
   enforcement (§1.1) and neither v1 template needs it. Returns with the git
   template; ported invariants 9, 10, 11 defer with it.
3. **The phase-7 demo constraint is recorded** in §7 here and in the plan's §6.

**Net effect — the headline property of v1:** `ez-factory` requests **no
unbounded capability at all**. `storage`, `filesystem: ["$CWD"]` (host-mediated,
realpath-checked, audited), `llm` (quota-capped), `triggers`, `workflows`. For an
extension meant to be installed by anyone, that is a defensible install prompt
and a product advantage — not a consolation for reduced scope.
