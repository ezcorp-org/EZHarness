/**
 * Per-API-key TOOL POLICY — the mint-time shape and the pure predicates the
 * three enforcement boundaries share.
 *
 * The axis this defends is *"what can this credential cause to execute"*, not
 * *"where does the LLM get its tools"*. Those are different sets: a workflow
 * run or an agent run is HTTP-initiated and never passes through the LLM's
 * tool surface at all. So the primary mechanism here is a per-key ROUTE
 * ALLOWLIST checked at the one auth choke point every `/api/*` request goes
 * through, and the mode/caller-tool predicates are the narrower rules that
 * apply on the routes the allowlist does permit.
 *
 * ABSENT POLICY IS TODAY'S BEHAVIOUR, BYTE FOR BYTE. Every predicate here
 * returns the permissive answer for a key with no `toolPolicy`, and for a
 * cookie session (which never carries one). Nothing in this module can make
 * an existing key do less than it does now.
 *
 * Lives in `src/auth/` — not under `web/` — because BOTH mint paths need it:
 * the HTTP route (`/api/settings/developer/api-keys`) and the CLI
 * (`ezcorp key mint --route-bundle …`), which cannot import `$lib`. It is
 * deliberately dependency-light for the same reason `api-key.ts` is: the
 * SvelteKit `handle` hook loads it on every request.
 */

import {
  MAX_CALLER_TOOLS,
  isValidCallerToolName,
} from "../runtime/caller-tool-declarations";

/**
 * The policy attached to one API key, stored as JSON on the key's settings
 * row. Every field is optional and every field is a NARROWING — a policy can
 * only take authority away from the scopes the key already holds.
 */
export interface ToolPolicy {
  /** Boundary 1 — REACH. SvelteKit route keys (`"METHOD /api/foo/[id]"`) this
   *  key may reach. Everything else is denied, INCLUDING routes added after
   *  the key was minted. Absent ⇒ no route confinement. */
  routeAllowlist?: string[];
  /** Caller-executed tool names this key may DECLARE on a conversation (and,
   *  via Boundary 3, execute). Absent ⇒ no name confinement. */
  allowedCallerTools?: string[];
  /** Ceiling on how many caller tools this key may declare, 1..{@link MAX_CALLER_TOOLS}.
   *  Absent ⇒ the global {@link MAX_CALLER_TOOLS} ceiling only. */
  maxCallerTools?: number;
  /** Boundary 2 — MODE. The one mode this key may run a conversation under.
   *  Checked against the PERSISTED `conversations.mode_id`, fail-closed on
   *  `null` (see {@link mayUseMode}). Absent ⇒ no mode confinement. */
  lockedModeId?: string;
}

/** Every field name a policy can constrain, in a stable order. The ceiling
 *  check iterates this rather than `Object.keys(actor)` so a field the actor
 *  happens not to carry can never be skipped by accident. */
export const TOOL_POLICY_FIELDS = [
  "routeAllowlist",
  "allowedCallerTools",
  "maxCallerTools",
  "lockedModeId",
] as const satisfies readonly (keyof ToolPolicy)[];

/** HTTP methods a route-allowlist entry may name. Matches the union
 *  `ApiRouteEntry["method"]` in `src/api-registry.ts`. */
const ALLOWLIST_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Ceiling on a single key's route allowlist. A bundle is ~14 entries; a
 *  hand-rolled list an order of magnitude larger is not confinement, and the
 *  hook does a linear scan of this array on every request. */
export const MAX_POLICY_ROUTES = 64;

/**
 * The named route bundles a key may be minted against.
 *
 * Minting from a NAME rather than a hand-typed list is what keeps the
 * allowlist from rotting: the bundle is reviewed once, here, and every entry
 * is validated against `src/api-registry.ts` at mint time (see
 * {@link validateToolPolicy}) so a typo is a 400 rather than a route that
 * silently denies forever.
 *
 * `desktop-companion` is the reference bundle: a connected client device that
 * drives one conversation, declares its own caller-executed tools, answers
 * their permission gates, and watches the event stream. Note what is ABSENT —
 * every task/assignment route, `agents/[name]/run`, `agent-configs`,
 * `workflows/[name]/run`, `briefing/*`, `ez-actions/[name]`, `agent-chat`,
 * message retry, and every `modes` MUTATION. Those are the HTTP-initiated
 * execution paths a companion key must not reach, and the reason Boundary 1
 * exists as its own layer.
 */
export const ROUTE_BUNDLES: Record<string, readonly string[]> = {
  "desktop-companion": [
    "POST /api/conversations",
    "PUT /api/conversations/[id]",
    "GET /api/conversations/[id]",
    "POST /api/conversations/[id]/messages",
    "PUT /api/conversations/[id]/caller-tools",
    "GET /api/conversations/[id]/caller-tools",
    "DELETE /api/conversations/[id]/caller-tools",
    "POST /api/conversations/[id]/tool-results",
    "GET /api/conversations/[id]/active-run",
    "POST /api/tool-calls/[id]/permission",
    "GET /api/runtime-events",
    "GET /api/runs/[id]",
    "GET /api/tools",
    "GET /api/modes",
  ],
};

/**
 * RUN-START ROUTES: every `/api/*` route that turns one HTTP request into an
 * agent run — `streamChat`, `runAgent`, `runWorkflow` or `startAssignment`.
 *
 * {@link MODE_GUARDED_RUN_START_ROUTES} is the subset that actually CALLS
 * {@link mayUseMode} today. The difference between the two sets is a hole, so
 * {@link validateToolPolicy} refuses to mint a `lockedModeId` policy that
 * REACHES an unguarded one — a route can join a bundle only after its guard
 * exists. "Reaches" means the allowlist when there is one and ALL of these
 * routes when there is not, because an absent allowlist confines nothing.
 *
 * THIS LIST IS HAND-WRITTEN AND THEREFORE UNTRUSTWORTHY ON ITS OWN. Its only
 * test used to be `MODE_GUARDED ⊆ CONVERSATION_RUN_START`, which is the
 * subset direction that cannot detect an omission — and it HAD omitted four
 * routes, two of them conversation-scoped (`…/tasks/[taskId]/…`, which reach
 * `startAssignment` and so start a run with no mode check at all). A
 * `lockedModeId` policy naming one of those validated cleanly and never
 * consulted the lock. `policy-run-start-surface.test.ts` now DERIVES the set
 * by walking every route handler under `web/src/routes/api/**` and fails when
 * this list and the tree disagree in EITHER direction.
 *
 * IT HAD OMITTED THE BRIEFING PAIR TOO, and for the reason the walk is pinned
 * rather than purely syntactic: `POST /api/briefing/run-now` reaches
 * `streamChat` through TWO cross-file hops (`triggerBriefingRunNow` →
 * `runBriefingForUser` → `executor.streamChat`), and `POST
 * /api/hub/pages/[id]/actions/[action]` reaches the SAME trigger by dynamic
 * dispatch through the hub-page provider registry. Both were absent, so
 * `validateToolPolicy` ACCEPTED a lock naming them; neither wired Boundary 3,
 * so the run they start kept `invoke_agent`/`run_workflow`
 * (`tools/filter.ts` `keep()` preserves orchestration through the read-only
 * branch, and only `forceDenyOrchestration` strips it).
 *
 * AND IT HAD OMITTED A TENTH, the same cross-file shape once more: `POST
 * /api/integrations/github-projects/proposals/[id]/approve` reaches
 * `executor.streamChat` through `approveProposal` (`src/integrations/
 * github-projects/spawn.ts`), which creates the conversation and launches the
 * run fire-and-forget. It is the WORST of the ten to have missed: the run's
 * permission mode defaults to `yolo` (every tool call auto-approved) and it
 * carries no `toolRestriction`, so with Boundary 3 unwired a policied
 * `extensions`-scoped key — a Bearer key, not a session — got the whole tool
 * surface plus `invoke_agent`/`run_workflow`.
 *
 * Scope note: the set is no longer conversation-scoped. `POST
 * /api/agents/[name]/run`, `POST /api/workflows/[name]/run`, the two briefing
 * entry points and the github-projects approve route start a run with no
 * PRE-EXISTING conversation to read a `mode_id` from, so a locked mode is not
 * enforceable on them even in principle — which is exactly why a locked key
 * must not be able to name them.
 */
export const RUN_START_ROUTES: readonly string[] = [
  "POST /api/agents/[name]/run",
  "POST /api/briefing/run-now",
  "POST /api/conversations/[id]/agent-chat",
  "POST /api/conversations/[id]/messages",
  "POST /api/conversations/[id]/messages/[mid]/retry",
  "POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start",
  "POST /api/conversations/[id]/tasks/[taskId]/retry",
  "POST /api/hub/pages/[id]/actions/[action]",
  "POST /api/integrations/github-projects/proposals/[id]/approve",
  "POST /api/workflows/[name]/run",
];

/**
 * The run-start routes that enforce {@link mayUseMode}. Grows only alongside a
 * real guard in the handler — `policy-run-start-surface.test.ts` asserts each
 * named route file actually calls {@link runStartPolicyDenial}.
 *
 * This is EVERY conversation-scoped run-start route. The five absentees —
 * `POST /api/agents/[name]/run`, `POST /api/workflows/[name]/run`,
 * `POST /api/briefing/run-now`, `POST /api/hub/pages/[id]/actions/[action]`
 * and `POST /api/integrations/github-projects/proposals/[id]/approve` — start a
 * run with no conversation to read a `mode_id` from, so a locked mode is not
 * enforceable on them even in principle: the briefing entries and the approve
 * route CREATE the conversation the run executes on (`run.ts` and
 * `approveProposal` both call `createConversation`, neither sets a `mode_id`),
 * so "its persisted mode" is a row that does not exist yet and a guard there
 * would be a constant refusal dressed up as a mode check. That is exactly why a
 * locked key must not be able to name them, and why a lock with NO allowlist
 * (reaching all five) is refused at mint — and, since the UNGUARDABLE ones are
 * also enforced at Boundary 1, refused at request time for keys minted before
 * that rule existed, allowlist or no allowlist.
 *
 * Scope of the guarantee, stated because the two shapes differ:
 *
 *  - `messages`, `messages/[mid]/retry` and `agent-chat` run `streamChat`
 *    against the very conversation whose `mode_id` was just checked, and each
 *    threads that same `modeId` into the call — so the lock both gates the
 *    reach AND applies the mode's tool scope to the run.
 *  - The two `tasks/…` routes spawn an ASSIGNMENT: `startAssignment` creates a
 *    fresh sub-conversation and runs it under the assignment's agent config.
 *    The lock gates WHICH conversations the key may spawn from; it does not
 *    narrow the spawned agent's tool surface (`startAssignment` takes neither a
 *    mode nor a {@link RunStartToolPolicyOptions} bag). That residual is
 *    identical for an unlocked policied key, so the lock is still a strict
 *    narrowing — but do not read more into it than that.
 */
export const MODE_GUARDED_RUN_START_ROUTES: readonly string[] = [
  "POST /api/conversations/[id]/agent-chat",
  "POST /api/conversations/[id]/messages",
  "POST /api/conversations/[id]/messages/[mid]/retry",
  "POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start",
  "POST /api/conversations/[id]/tasks/[taskId]/retry",
];

/** Resolve a bundle name to its route list. Unknown name ⇒ `null`, so the
 *  mint paths answer "unknown bundle" instead of minting an empty (= deny
 *  everything) allowlist. */
export function resolveRouteBundle(name: string): readonly string[] | null {
  return ROUTE_BUNDLES[name] ?? null;
}

/** Bundle names, for CLI help text and the mint route's error message. */
export function routeBundleNames(): string[] {
  return Object.keys(ROUTE_BUNDLES).sort();
}

/**
 * Rewrite a SvelteKit route id (`/api/conversations/[id]`) into the
 * `src/api-registry.ts` path form (`/api/conversations/:id`).
 *
 * The allowlist is stored in ROUTE-ID form because that is what
 * `event.route.id` gives the hook — comparing anything else would mean
 * re-deriving a match the framework already did. The registry is the only
 * exhaustive list of real routes (the route-contract meta-test enforces it in
 * both directions), so validation converts rather than duplicating.
 */
export function routeIdToRegistryPath(routeId: string): string {
  return routeId
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

/** The minimal registry shape {@link validateToolPolicy} needs. Injected
 *  rather than imported so the validator stays pure and the CLI/route/test
 *  all agree on which registry snapshot was checked. */
export interface ToolPolicyRegistryEntry {
  method: string;
  path: string;
}

export interface ValidateToolPolicyContext {
  /** Resolve a mode id that must be visible to `ownerId`. `null`/`undefined`
   *  ⇒ no such mode for that owner (the fail-closed answer). */
  getMode: (
    id: string,
    ownerId: string,
  ) => Promise<{ id: string } | null | undefined>;
  /** The user the key is being minted FOR — a key must never be locked to a
   *  mode its own owner cannot see. */
  ownerId: string;
  registry: readonly ToolPolicyRegistryEntry[];
}

/**
 * Full mint-time validation of a requested policy.
 *
 * Returns `null` when the policy is acceptable (including when there is no
 * policy at all), or a non-empty list of human-readable problems. Callers
 * turn a non-empty result into a 400 (HTTP) or an exit(1) (CLI) — this is a
 * CLIENT error, never a server fault, because a policy is data the caller
 * chose.
 */
export async function validateToolPolicy(
  policy: ToolPolicy | undefined | null,
  ctx: ValidateToolPolicyContext,
): Promise<string[] | null> {
  if (!policy) return null;

  const errors: string[] = [];

  const constrained = TOOL_POLICY_FIELDS.filter(
    (f) => policy[f] !== undefined,
  );
  if (constrained.length === 0) {
    // An empty policy is not "no policy": it would still mark the key as
    // policied and so trip the autopilot refusals, while confining nothing.
    // Refuse it rather than mint something whose meaning nobody can read off
    // the row.
    return ["toolPolicy must constrain at least one field"];
  }

  if (policy.routeAllowlist !== undefined) {
    errors.push(...validateRouteAllowlist(policy.routeAllowlist, ctx.registry));
  }

  if (policy.allowedCallerTools !== undefined) {
    errors.push(...validateAllowedCallerTools(policy.allowedCallerTools));
  }

  if (policy.maxCallerTools !== undefined) {
    const n = policy.maxCallerTools;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CALLER_TOOLS) {
      errors.push(
        `maxCallerTools must be an integer 1..${MAX_CALLER_TOOLS} (got ${String(n)})`,
      );
    }
  }

  if (policy.lockedModeId !== undefined) {
    if (typeof policy.lockedModeId !== "string" || policy.lockedModeId.length === 0) {
      errors.push("lockedModeId must be a non-empty string");
    } else {
      const mode = await ctx.getMode(policy.lockedModeId, ctx.ownerId);
      if (!mode) {
        errors.push(
          `lockedModeId "${policy.lockedModeId}" is not a mode visible to the key owner`,
        );
      }
    }
    // A locked mode that the key can route AROUND is not a lock. Every
    // run-start route the key REACHES must be one that actually calls
    // mayUseMode; otherwise the mint is refused so the hole cannot ship as a
    // bundle entry.
    //
    // THE REACHABLE SET IS NOT THE ALLOWLIST WHEN THERE IS NO ALLOWLIST. This
    // check read absent as `?? []` — iterate nothing, pass vacuously — while
    // Boundary 1 binds on POSITIVE PRESENCE (`if (routeAllow)` in
    // `hooks.server.ts`), so an absent allowlist reaches EVERY route. That made
    // the guard NON-MONOTONIC: it refused
    // `{lockedModeId, routeAllowlist:["POST /api/agents/[name]/run"]}` and
    // accepted the strictly WIDER `{lockedModeId}` — and the wider key was the
    // one that could detour to an unguarded run-start route, skip `mayUseMode`
    // entirely, and get back the unfiltered tool surface (`shell` included). A
    // key minted `--locked-mode` with no bundle reported as confined and was
    // not. Nothing wider than a refused policy may be accepted.
    const guarded = new Set(MODE_GUARDED_RUN_START_ROUTES);
    if (policy.routeAllowlist === undefined) {
      const unguardable = RUN_START_ROUTES.filter((r) => !guarded.has(r));
      errors.push(
        `lockedModeId requires a routeAllowlist: with none the key reaches EVERY route, ` +
          `including ${unguardable.length} run-start route(s) where the lock cannot be enforced ` +
          `(${unguardable.join(", ")}). Mint with a route bundle (${routeBundleNames().join(", ")}) ` +
          `or name a routeAllowlist that excludes them.`,
      );
    } else if (Array.isArray(policy.routeAllowlist)) {
      // A present-but-malformed allowlist (not an array) is already refused by
      // validateRouteAllowlist, so there is no reachable set to reason about.
      for (const r of policy.routeAllowlist) {
        if (RUN_START_ROUTES.includes(r) && !guarded.has(r)) {
          errors.push(
            `lockedModeId cannot be enforced on "${r}" — remove it from routeAllowlist`,
          );
        }
      }
    }
  }

  return errors.length > 0 ? errors : null;
}

function validateRouteAllowlist(
  routes: unknown,
  registry: readonly ToolPolicyRegistryEntry[],
): string[] {
  if (!Array.isArray(routes) || routes.length === 0) {
    return ["routeAllowlist must be a non-empty array"];
  }
  if (routes.length > MAX_POLICY_ROUTES) {
    return [`routeAllowlist may name at most ${MAX_POLICY_ROUTES} routes`];
  }
  const errors: string[] = [];
  const known = new Set(registry.map((e) => `${e.method} ${e.path}`));
  const seen = new Set<string>();
  for (const entry of routes) {
    if (typeof entry !== "string") {
      errors.push("routeAllowlist entries must be strings");
      continue;
    }
    if (seen.has(entry)) {
      errors.push(`routeAllowlist names "${entry}" twice`);
      continue;
    }
    seen.add(entry);
    const space = entry.indexOf(" ");
    const method = space === -1 ? "" : entry.slice(0, space);
    const routeId = space === -1 ? "" : entry.slice(space + 1);
    if (!ALLOWLIST_METHODS.has(method) || !routeId.startsWith("/api/")) {
      errors.push(
        `routeAllowlist entry "${entry}" must be "METHOD /api/…" (METHOD one of ${[...ALLOWLIST_METHODS].join(", ")})`,
      );
      continue;
    }
    if (!known.has(`${method} ${routeIdToRegistryPath(routeId)}`)) {
      // A typo here would otherwise mint a key that is denied on a route the
      // operator believes they granted — a silent deny, and the failure mode
      // that makes route allowlists rot.
      errors.push(`routeAllowlist entry "${entry}" is not a registered route`);
    }
  }
  return errors;
}

function validateAllowedCallerTools(names: unknown): string[] {
  if (!Array.isArray(names) || names.length === 0) {
    return ["allowedCallerTools must be a non-empty array"];
  }
  if (names.length > MAX_CALLER_TOOLS) {
    return [`allowedCallerTools may name at most ${MAX_CALLER_TOOLS} tools`];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !isValidCallerToolName(name)) {
      errors.push(
        `allowedCallerTools entry ${JSON.stringify(name)} is not a legal caller-tool name`,
      );
      continue;
    }
    if (seen.has(name)) errors.push(`allowedCallerTools names "${name}" twice`);
    seen.add(name);
  }
  return errors;
}

/**
 * Anti-widening gate at mint time: which fields of `requested` are WIDER than
 * the acting key's own `actor` policy?
 *
 * The rule that matters, and the one v3 of this design got wrong: for every
 * field the ACTOR constrains, **absent-in-request is widening**. A policied
 * actor that could mint a key with no `routeAllowlist` would have laundered
 * its own confinement into an unconfined credential in one request. So a
 * policied actor can mint only an equal-or-narrower key on every field, and
 * can never mint an unpolicied one.
 *
 * An UNPOLICIED actor is unconstrained and may mint anything — which is the
 * common case, since the mint route is `admin`-scoped and admins are not
 * normally policied.
 *
 * Returns the offending field names (empty ⇒ within ceiling).
 */
export function policyOverCeiling(
  actor: ToolPolicy | undefined | null,
  requested: ToolPolicy | undefined | null,
): string[] {
  if (!actor) return [];
  const req: ToolPolicy = requested ?? {};
  const over: string[] = [];

  if (actor.routeAllowlist !== undefined) {
    const allowed = new Set(actor.routeAllowlist);
    if (
      req.routeAllowlist === undefined ||
      req.routeAllowlist.some((r) => !allowed.has(r))
    ) {
      over.push("routeAllowlist");
    }
  }

  if (actor.allowedCallerTools !== undefined) {
    const allowed = new Set(actor.allowedCallerTools);
    if (
      req.allowedCallerTools === undefined ||
      req.allowedCallerTools.some((t) => !allowed.has(t))
    ) {
      over.push("allowedCallerTools");
    }
  }

  if (actor.maxCallerTools !== undefined) {
    if (
      req.maxCallerTools === undefined ||
      req.maxCallerTools > actor.maxCallerTools
    ) {
      over.push("maxCallerTools");
    }
  }

  if (actor.lockedModeId !== undefined) {
    // A DIFFERENT mode is not narrower — it is a different confinement the
    // actor was never granted. Only the identical lock is within ceiling.
    if (req.lockedModeId !== actor.lockedModeId) over.push("lockedModeId");
  }

  return over;
}

/**
 * Boundary 2 — may a policied key run a conversation whose PERSISTED
 * `mode_id` is `modeId`?
 *
 * FAIL-CLOSED ON `null`, deliberately. `modes.user_id` is `ON DELETE SET
 * NULL` and the conversation's `mode_id` is `ON DELETE SET NULL` too, so the
 * owner deleting the locked mode from their own cookie session turns
 * `conv.modeId` into `null`. Treating that as "unconstrained" would mean the
 * one action the key cannot perform (deleting the mode) is also the action
 * that FREES it. So a deleted locked mode BRICKS the key instead — the owner
 * re-points the conversation at a live mode, or mints a new key.
 */
export function mayUseMode(
  policy: ToolPolicy | undefined | null,
  modeId: string | null,
): boolean {
  if (!policy?.lockedModeId) return true;
  if (modeId === null) return false;
  return modeId === policy.lockedModeId;
}

/** A Boundary-2 refusal. `field` names the constraint that refused so the
 *  route can echo it verbatim and a client can tell "wrong mode" from
 *  "autopilot" without parsing prose. */
export interface RunStartPolicyDenial {
  field: "lockedModeId" | "goal";
  message: string;
}

/**
 * Boundary 2, as one predicate — everything a policied key is refused at a
 * conversation-scoped run-start route.
 *
 * Three refusals, all fail-closed, all no-ops for an unpolicied principal:
 *
 *  1. **Wrong (or deleted) mode.** See {@link mayUseMode}.
 *  2. **Arming autopilot.** `/goal <condition>` is the single arming path
 *     (`writePersistedGoal` is reached only from `handleGoalCommand`), so
 *     refusing the command is refusing the arm.
 *  3. **Any send to a goal-armed conversation.** `metadata.goal` present ⇒
 *     armed, whether the goal is running or paused — paused-ness lives only
 *     in memory. This blocks both DRIVING an armed conversation and RESUMING
 *     a paused one, which is what makes "a policied key can never cause an
 *     autopilot turn" true rather than approximately true. It is not a
 *     permanent brick: the owner's `/goal clear` deletes the key and the
 *     conversation is usable again.
 *
 * The owner's OWN cookie session is never touched by any of this. Policy
 * binds the key, not the human.
 */
export function runStartPolicyDenial(
  policy: ToolPolicy | undefined | null,
  conv: { modeId: string | null; metadata?: { goal?: unknown; [k: string]: unknown } | null },
  opts: { isGoalCommand: boolean },
): RunStartPolicyDenial | null {
  if (!policy) return null;
  if (!mayUseMode(policy, conv.modeId)) {
    return {
      field: "lockedModeId",
      message:
        conv.modeId === null
          ? "This key is locked to a mode; the conversation has none"
          : "This key is locked to a different mode",
    };
  }
  if (opts.isGoalCommand) {
    return { field: "goal", message: "This key may not arm autopilot" };
  }
  if (conv.metadata?.goal !== undefined && conv.metadata.goal !== null) {
    return {
      field: "goal",
      message: "This key may not send to a conversation with an armed goal",
    };
  }
  return null;
}

/**
 * Boundary 3, as `streamChat` options — the two fields a run-start route must
 * pass so the run inherits the confinement of the credential that asked for
 * it.
 *
 * Shape-matched to `AgentExecutor.streamChat`'s options (`executor.ts`), and
 * spread into the call rather than assigned field by field, so a route can
 * neither wire half of the boundary nor drift from the other routes.
 *
 * The bag is also what gets THREADED when the run starts behind a helper: the
 * briefing entry points derive it at the route (so the wiring stays greppable
 * from the route side, which is the only side that caught the inert Boundary 3)
 * and hand it down through `triggerBriefingRunNow` → `runBriefingForUser` into
 * the same spread; the github-projects approve route hands it to
 * `approveProposal` through its `ApproveDeps` injection seam, which spreads it
 * into the spawn bridge's own `streamChat`. Deriving it at the route and
 * dropping it on the way is the failure this type exists to make visible —
 * which is why each hop is asserted at the EXECUTOR's options bag, not at the
 * route's intent.
 */
export interface RunStartToolPolicyOptions {
  /** Bare declaration names this run may wire/execute as caller tools.
   *  Absent ⇒ no name cap. */
  callerToolAllowlist?: string[];
  /** Strip the LLM's spawn primitives from the run's tool surface. */
  forceDenyOrchestration?: boolean;
}

/**
 * Derive Boundary 3 from the requesting principal's policy.
 *
 * WHY IT IS A FUNCTION AND NOT TWO INLINE READS. Boundary 3 shipped INERT:
 * `streamChat` declared both options, `setup-tools` threaded them, and a test
 * injected them straight into `streamChat` — so the boundary tested green
 * while no route in the product ever set either one. A policied key's
 * spawn-deny did nothing mid-turn, which is the precise gap Boundary 3 exists
 * to close. Deriving both from one function makes the wiring greppable and
 * lets `policy-run-start-surface.test.ts` assert, from the ROUTE side, that
 * every `streamChat` run-start route calls it.
 *
 * ANY policy ⇒ spawn-deny. Boundaries 1 and 3 are two halves of one
 * confinement: the route allowlist denies HTTP-initiated execution
 * (`agents/[name]/run`, `workflows/[name]/run`, every task route), and a
 * mid-turn `invoke_agent` issues no HTTP request, so only Boundary 3 can see
 * it. A key confined on any axis is a leaf credential; it does not get to
 * spawn. An empty policy cannot reach here — {@link validateToolPolicy}
 * refuses to mint one.
 *
 * No policy ⇒ `{}`, so a cookie session and an unpolicied key spread nothing
 * and get the pre-policy surface byte for byte.
 */
export function runStartToolPolicyOptions(
  policy: ToolPolicy | undefined | null,
): RunStartToolPolicyOptions {
  if (!policy) return {};
  return {
    ...(policy.allowedCallerTools !== undefined
      ? { callerToolAllowlist: [...policy.allowedCallerTools] }
      : {}),
    forceDenyOrchestration: true,
  };
}

/** Why a caller-tool declaration was refused. `field` names the constraint so
 *  the route can report it verbatim; `offender` names the tool when one entry
 *  is at fault (a count violation has no single offender). */
export type CallerToolPolicyVerdict =
  | { ok: true }
  | {
      ok: false;
      field: "allowedCallerTools" | "maxCallerTools";
      offender?: string;
    };

/**
 * May a policied key DECLARE this set of caller-executed tool names?
 *
 * The declaration cap and Boundary 3's execution cap are both needed: this
 * one stops the bag from being written at all, and the execution cap filters
 * a bag a DIFFERENT principal (the owner's cookie session) wrote onto the
 * same conversation earlier.
 */
export function mayDeclareCallerTools(
  policy: ToolPolicy | undefined | null,
  names: readonly string[],
): CallerToolPolicyVerdict {
  if (!policy) return { ok: true };
  if (policy.maxCallerTools !== undefined && names.length > policy.maxCallerTools) {
    return { ok: false, field: "maxCallerTools" };
  }
  if (policy.allowedCallerTools !== undefined) {
    const allowed = new Set(policy.allowedCallerTools);
    const offender = names.find((n) => !allowed.has(n));
    if (offender !== undefined) {
      return { ok: false, field: "allowedCallerTools", offender };
    }
  }
  return { ok: true };
}
