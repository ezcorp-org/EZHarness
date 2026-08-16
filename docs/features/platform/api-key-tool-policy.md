# Per-API-Key Tool Policy

A **tool policy** confines one `ezk_*` API key below the authority its scopes
would otherwise grant. It answers a question scopes cannot: *what can this
credential cause to execute?*

That is a strictly larger question than *"what tools does the LLM get"*. A
workflow run, an agent run, or a briefing run starts a run over HTTP with **no
LLM tool call at all**, so no tool-surface filter can see them. The primary
mechanism here is therefore a per-key **route allowlist** checked at the single
auth choke point every `/api/*` request passes through.

**Absent policy is today's behaviour, byte for byte.** A key minted without a
policy, a cookie session, and an internal `ezkint_` principal all take the
permissive path in every predicate. Nothing here can make an existing key do
less than it does now.

## The three boundaries

| | Enforces | Where |
|---|---|---|
| **1 — Reach** | `routeAllowlist`: the key reaches only the routes it was minted for, including routes added to the app later | `web/src/hooks.server.ts` (pre-`resolve()`) |
| **2 — Mode** | `lockedModeId`: run-start refused unless the conversation's PERSISTED `mode_id` matches; plus no arming autopilot and no sending to a goal-armed conversation | every conversation-scoped run-start route (5 — see below) |
| **3 — Run tool surface** | `allowedCallerTools` at execution, and a namespace-stripping deny of the LLM's spawn primitives | `src/runtime/tools/filter.ts` + `executor.ts`, wired by every run-start route |

Boundaries 1 and 3 are complementary, not alternatives: 1 covers
HTTP-initiated execution, 3 covers LLM-initiated execution. `allowedCallerTools`
and `maxCallerTools` are additionally enforced at **declaration** time on
`PUT /api/conversations/[id]/caller-tools`, because the bag on a conversation
may have been written by a different principal (the owner's own browser).

**Boundary 3 is derived at the route, from one function.**
`runStartToolPolicyOptions(locals.apiKeyToolPolicy)` returns the two
`streamChat` options (`callerToolAllowlist`, `forceDenyOrchestration`), and
every run-start route that can carry them spreads it into the call — `messages`,
`agent-chat`, message `retry`, (through the shared briefing trigger)
`briefing/run-now` plus `hub/pages/[id]/actions/[action]`, and (through the
spawn bridge) `integrations/github-projects/proposals/[id]/approve`. ANY policy ⇒
spawn-deny: a key confined on any axis is a leaf credential, and a mid-turn
`invoke_agent` issues no HTTP request for Boundary 1 to see. No policy ⇒ `{}`,
so a cookie session and an unpolicied key are unchanged.

The three INDIRECT entry points derive the bag AT THE ROUTE and thread it down:
`triggerBriefingRunNow(userId, bag)` → `runBriefingForUser(config, {
toolPolicyOptions })` → `streamChat` for the briefing pair, and
`approveProposal(id, actor, { toolPolicyOptions })` → `streamChat` for the
github-projects approve route. Derived at the route because that is the only
layer that knows the principal, and the only side the surface test can read;
threaded rather than re-derived because the run is fire-and-forget and one or
two hops away. `toolRestriction: "read-only"` does **not** substitute for it —
`tools/filter.ts` `keep()` preserves `invoke_agent`/`run_workflow` through the
read-only branch, so `forceDenyOrchestration` is the only layer that removes
them. On the approve route there is not even a restriction to lean on: the
spawned run's permission mode defaults to `yolo` (every tool call
auto-approved), so Boundary 3 is the *whole* mid-turn control there.

It is one function rather than two inline reads because Boundary 3 first
shipped **inert**: the options existed, `setup-tools` threaded them, and the
only setter was a test injecting them straight into `streamChat` — so the
layer tested green while no route in the product set either one, and a
policied key's spawn-deny did nothing mid-turn.
`src/__tests__/policy-run-start-surface.test.ts` now asserts the wiring from
the ROUTE side, which is the side that was blind.

The other four run-start routes (`agents/[name]/run`, `workflows/[name]/run`
and the two task routes) take no such option — `runAgent`, `runWorkflow` and
`startAssignment` have no per-run policy parameter. The two task routes still
run **Boundary 2**; the two `run` routes have no conversation at all, so
Boundary 1 is the whole control on them.

**Boundary 2 runs on all five conversation-scoped run-start routes**:
`messages`, `messages/[mid]/retry`, `agent-chat`, `tasks/[taskId]/retry` and
`tasks/[taskId]/assignments/[assignmentId]/start`. The first three run
`streamChat` against the very conversation whose `mode_id` was just checked and
thread that same `modeId` into the call, so the lock gates the reach **and**
applies the mode's tool scope to the run. The two task routes spawn an
assignment: `startAssignment` creates a fresh sub-conversation and runs it under
the assignment's agent config, so the lock gates *which conversations the key
may spawn from* and does not narrow the spawned agent's surface. That residual
is identical for an unlocked policied key, so the lock is still a strict
narrowing — but do not read more into it.

**Boundary 2 is NOT wired on the two briefing entry points or on the
github-projects approve route, deliberately.** `runBriefingForUser` and
`approveProposal` both CREATE the conversation their run executes on, so there is
no persisted `mode_id` when a guard would run: `mayUseMode` would read `null`
and refuse every locked key unconditionally — a constant dressed up as a mode
check, and a mint that then reports those routes as guarded. Locked keys are
refused where the refusal is honest instead: at mint, and at Boundary 1 for
keys minted before that rule existed.

## Shape

```ts
interface ToolPolicy {
  routeAllowlist?: string[];     // "METHOD /api/foo/[id]" — SvelteKit route ids
  allowedCallerTools?: string[];
  maxCallerTools?: number;       // 1..16
  lockedModeId?: string;
}
```

It rides the `ApiKeyEntry` JSON at the `apikey:<userId>:<keyId>` settings row —
optional on-disk, exactly like `role`, so there is no migration. Hydrated at
**both** `verifyApiKey` return sites (hash-index fast path and legacy scan) and
stamped onto `locals.apiKeyToolPolicy` in `bearer-auth.ts`. Forgery of a
`toolPolicy` through the settings API stays closed by the `apikey:` /
`apikeyhash:` deny-list.

## Minting

```sh
ezcorp key mint --user you@example.com --scopes read,write,chat \
  --route-bundle desktop-companion \
  --locked-mode <modeId> --caller-tools open_app --max-caller-tools 1
```

or `POST /api/settings/developer/api-keys` with a `toolPolicy` (accepting
`routeBundle` as an input alias for `routeAllowlist`), which
`HarnessClient.mintApiKey` wraps.

Four checks run in a fixed order, and the order is the contract:

1. `scopesOverCeiling` — a key never carries authority its owner lacks
2. `canMintRole` — minting an admin-ROLE key requires an admin actor
3. `policyOverCeiling` — what the ACTOR may hand out
4. `validateToolPolicy` — whether the request is intrinsically valid

**`policyOverCeiling`: absent-in-request is WIDENING.** For every field the
acting key's own policy constrains, omitting that field from the request is
reported as widening — so a policied actor can mint only an equal-or-narrower
key on every field, and can **never** mint an unpolicied one. An unpolicied
actor is unconstrained, which is the common case (the mint route is
`admin`-scoped).

**`validateToolPolicy` resolves every route against `src/api-registry.ts`.** A
typo would otherwise mint a key denied on a route its operator believes they
granted — a silent deny, and the failure mode that makes route allowlists rot.
It also refuses a `lockedModeId` that REACHES any run-start route which does not
run the mode guard, so the guarded set and the reachable set cannot drift apart.

**A `lockedModeId` REQUIRES a `routeAllowlist`.** "Reaches" means the allowlist
when there is one and **every** run-start route when there is not, because
Boundary 1 engages only on positive presence (`if (routeAllow)` in
`hooks.server.ts`) — an absent allowlist confines nothing. So
`ezcorp key mint --locked-mode <id>` with no `--route-bundle` is a refusal, and
the message names the routes and a bundle to use instead.

This check was **non-monotonic** and that was a vulnerability. It derived reach
from `policy.routeAllowlist ?? []`, so the absent case iterated nothing and
passed vacuously: the guard REFUSED
`{lockedModeId, routeAllowlist:["POST /api/agents/[name]/run"]}` while ACCEPTING
the strictly wider `{lockedModeId}`. A key minted `--locked-mode` with no bundle
reported as confined and was not — the holder detoured to a run-start route that
never called `mayUseMode` and had the mode's denied tools back, `shell`
included. The invariant asserted in `tool-policy.test.ts` is **family-scoped**,
because the global reading is false: among policies that CLAIM A LOCK, widening
the reach never turns a refusal into an acceptance. It is not monotone over all
policies — `{lockedModeId, allowedCallerTools:[t]}` is refused while the
strictly wider `{allowedCallerTools:[t]}` is accepted, and correctly so: the
refusal exists to stop a key that ADVERTISES a lock it cannot enforce, and a
key claiming no lock makes no such promise. That counterexample is pinned as
its own test so the claim cannot be quietly widened back.

**A locked key is also refused at REQUEST time, not only at mint.** The mint
fix does nothing for keys already issued — Boundary 1 read
`policy?.routeAllowlist` and branched on it, so `{lockedModeId}` with no
allowlist was enforced on nothing until somebody re-minted it.
`lockedModeRunStartDenial` (`route-allowlist.ts`, called from
`toolPolicyRouteDenial` which the hook now uses) closes both shapes the mint
rejects, and the denied set differs by shape:

- **no `routeAllowlist`** ⇒ **every** `RUN_START_ROUTES` entry, so the runtime
  verdict equals the mint verdict: a policy the mint would reject starts no runs;
- **an allowlist** ⇒ the UNGUARDABLE entries only
  (`RUN_START_ROUTES ∖ MODE_GUARDED_RUN_START_ROUTES`). A key minted before this
  rule as `{lockedModeId, routeAllowlist:["POST /api/briefing/run-now"]}` was
  otherwise served by every layer — the allowlist arm permits (the route IS
  allowlisted) and the route has no Boundary 2 — leaving the lock advertised and
  enforced nowhere. The mode-guarded routes are *not* denied here: they are the
  shape `--route-bundle` exists to produce, and Boundary 2 really does check
  them.

Neither arm can refuse a policy that is mintable today, so this is retroactive
enforcement of the mint's verdict rather than a new constraint. When both arms
would fire, the allowlist refusal wins — its message ("widen the bundle") is the
actionable one. Non-run-start routes are untouched — it is a run-start rule, not
a quarantine — and a policy with no `lockedModeId`, including none at all, never
reaches the rule. Re-mint with a bundle to restore run-start reach.

**`RUN_START_ROUTES` is derived from the tree, not trusted as a list.** The
hand-written predecessor named three routes and had omitted four — including
`…/tasks/[taskId]/assignments/[…]/start` and `…/tasks/[taskId]/retry`, which
reach `startAssignment` and so started a run with no mode check at all. Its only
test asserted `MODE_GUARDED ⊆ RUN_START`, the subset direction that cannot
detect an omission.
`src/__tests__/policy-run-start-surface.test.ts` walks every handler under
`web/src/routes/api/**` per exported HTTP verb and fails when the list and the
tree disagree in either direction — for `RUN_START_ROUTES` **and** for
`MODE_GUARDED_RUN_START_ROUTES`, whose members it derives by finding the routes
that actually call `runStartPolicyDenial`.

The walk is intra-file plus PINNED cross-file hops, and that limit hid three more
run-start routes: `briefing/run-now` reaches `streamChat` through
`triggerBriefingRunNow` → `runBriefingForUser` (no primitive in the route file
at all), `hub/pages/[id]/actions/[action]` reaches the same trigger by
DYNAMIC DISPATCH through the hub-page provider registry, and
`integrations/github-projects/proposals/[id]/approve` reaches it through
`approveProposal`, which creates the conversation and launches the run
fire-and-forget. All three were absent from `RUN_START_ROUTES`, so a lock could
name any of them; all three now seed the walk from the entry-point token, and
the hops themselves are asserted so a bag dropped halfway down fails the suite.

The suite's docblock also records what is deliberately OUT and why: routes that
ADVANCE a run somebody else started (`workflows/runs/[id]/resume`, the workflow
analogue of `tool-calls/[id]/permission` — which `desktop-companion` grants on
purpose), routes that only SIMULATE (`workflows/[name]/dry-run`), and the
extension-dispatch doors (`extensions/[name]/events/[event]`,
`ez-actions/[name]`, `hooks/[extensionId]/[slug]`), whose reach is decided per
extension by its approved permission grant rather than by a route allowlist.

Five of the ten routes (`agents/[name]/run`, `workflows/[name]/run`,
`briefing/run-now`, `hub/pages/[id]/actions/[action]`,
`integrations/github-projects/proposals/[id]/approve`) have no conversation to
read a `mode_id` from, so a lock is not enforceable on them even in principle —
which is exactly why a locked key must not be able to REACH one: not with an
absent allowlist (which reaches all five), and not by naming one in an
allowlist. Both are refused at mint, and both at Boundary 1.

## Route bundles

Mint from a reviewed NAME, not a hand-typed list. `desktop-companion` is the 14
routes a connected client device needs to drive one conversation, declare its
own caller tools, answer their permission gates and watch the event stream.
Absent from it, deliberately: every task/assignment route, `agents/[name]/run`,
`agent-configs`, `workflows/[name]/run`, `briefing/*`, `ez-actions/[name]`,
`agent-chat`, message retry, and every `modes` MUTATION.

The bundle NAME is never stored — it is expanded at mint, because a stored name
would silently change meaning the day the bundle is edited.

## Fail-closed rules worth knowing

- **An unmatched path denies.** SvelteKit leaves `event.route.id === null`, which
  becomes a key no validated allowlist can hold.
- **A deleted locked mode BRICKS the key.** `conversations.mode_id` is
  `ON DELETE SET NULL`, and the owner can delete a mode from their own browser.
  Reading the resulting `null` as "unconstrained" would make the one action the
  key cannot perform the action that frees it. The owner re-points the
  conversation at a live mode, or mints a new key.
- **A goal-armed conversation refuses every policied send**, drive and resume
  alike — `metadata.goal` present means armed whether or not the goal is
  running. `/goal clear` deletes the key and the conversation is usable again.

## Honest limits

A policied key sends arbitrary text and uses every non-spawn tool the locked
mode grants — content is not constrained. **A mode handed to a policied key
must not contain `shell` or `edit_file`.** The human owner is never
constrained; this is not tenant isolation. And a deliberately over-wide bundle
is a footgun no code can catch — bundle review is the control.

## Key files

- `src/auth/tool-policy.ts` — the shape, `ROUTE_BUNDLES`, `RUN_START_ROUTES`,
  and every predicate (`policyOverCeiling`, `validateToolPolicy`,
  `mayUseMode`, `mayDeclareCallerTools`, `runStartPolicyDenial`,
  `runStartToolPolicyOptions`)
- `src/__tests__/policy-run-start-surface.test.ts` — the tree-derived
  assertion that keeps `RUN_START_ROUTES` exhaustive and Boundary 3 wired
- `web/src/lib/server/security/route-allowlist.ts` — the hook predicates
  (`routeAllowlistDenial`, `lockedModeRunStartDenial`, and
  `toolPolicyRouteDenial` which the hook calls) + the 403 shape
- `web/src/hooks.server.ts` — Boundary 1, after the auth branch closes
- `web/src/lib/server/briefing-run-now.ts`, `src/runtime/briefing/run.ts` —
  the shared briefing trigger and the pipeline it hands `toolPolicyOptions` to
- `src/runtime/hub-pages.ts` — `HubPageContext.toolPolicyOptions`, the bag the
  actions route derives for every core Hub action
- `src/integrations/github-projects/spawn.ts` — `ApproveDeps.toolPolicyOptions`,
  the bag the approve route derives and the spawn bridge spreads into its
  `streamChat`
- `web/src/lib/server/security/api-keys.ts` — hydration at both verify sites
- `web/src/lib/server/security/bearer-auth.ts` — stamps `locals.apiKeyToolPolicy`
- `web/src/routes/api/settings/developer/{schema.ts,api-keys/+server.ts}` — HTTP mint
- `src/cli.ts` — `ezcorp key mint --route-bundle …`
- `web/e2e/real-auth/api-key-tool-policy.spec.ts` — the real-tier walkthrough
