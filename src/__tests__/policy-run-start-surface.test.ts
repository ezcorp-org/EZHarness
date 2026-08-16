/**
 * The TREE-WIDE static assertion that keeps `RUN_START_ROUTES` honest, and
 * that keeps Boundary 3 WIRED.
 *
 * TWO DEFECTS SHIPPED BECAUSE NEITHER OF THESE WAS ASSERTED FROM THE TREE.
 *
 *   • `CONVERSATION_RUN_START_ROUTES` (this list's predecessor) was
 *     hand-written and named three routes. Its only test asserted
 *     `MODE_GUARDED ⊆ CONVERSATION_RUN_START` — the subset direction that
 *     CANNOT detect an omission. It had omitted FOUR run-start routes, two of
 *     them conversation-scoped: `…/tasks/[taskId]/assignments/[…]/start` and
 *     `…/tasks/[taskId]/retry` both reach `startAssignment`, which starts a
 *     run with no mode check anywhere on the path. The mint route takes a raw
 *     `routeAllowlist`, so a `lockedModeId` policy naming one of those
 *     validated cleanly and then never consulted the lock.
 *
 *   • `MODE_GUARDED_RUN_START_ROUTES` was asserted only in the SUBSET
 *     direction here too ("every listed route calls the guard"), which cannot
 *     see a route that starts a run and calls NOTHING. Four did. The mint-time
 *     refusal was supposed to compensate — but it derived the key's reach from
 *     `policy.routeAllowlist ?? []`, so a `{lockedModeId}` policy with NO
 *     allowlist iterated nothing and validated, while Boundary 1 binds on
 *     positive presence and let that key reach EVERY route. The guard REFUSED
 *     `{lock, routeAllowlist:[agent-chat]}` and ACCEPTED the strictly wider
 *     `{lock}`. Both directions are now derived from the tree.
 *
 *   • Boundary 3 shipped INERT. `streamChat` declared `callerToolAllowlist`
 *     and `forceDenyOrchestration`, `setup-tools` threaded them, and a test
 *     injected them directly into `streamChat` — so the boundary was green
 *     while NO route in the product set either option. A policied key's
 *     spawn-deny did nothing mid-turn. That is why the wiring assertion here
 *     reads the ROUTE files: asserting from inside `streamChat` is precisely
 *     the blind spot that let it ship.
 *
 * So both expectations are DERIVED FROM THE SOURCE. This suite walks every
 * `+server.ts` under `web/src/routes/api/**`, propagates reachability to the
 * run-start primitives per EXPORTED HTTP VERB, and fails when the tree and
 * the lists disagree in either direction.
 *
 * The walker (segment → seed → propagate to a fixed point) is
 * `helpers/source-walk.ts`, shared with `policy-spawn-deny-surface.test.ts`.
 * Its comment stripper is load-bearing here too: `tool-invoke/+server.ts`
 * names `streamChat` only in a comment, and `messages/[mid]/retry` names it
 * four times in prose above the one line that calls it.
 *
 * ── The known limit, stated rather than hidden — and what it cost ─────
 * Reachability is intra-file plus PINNED cross-file hops (see "the cross-file
 * hops are real"). A future route that starts a run through some new helper
 * whose name is on neither list is invisible to this walk — the same limit
 * `policy-spawn-deny-surface.test.ts` carries, and the reason both suites
 * keep a dead-detector: {@link MUST_DETECT} pins the routes the analysis is
 * KNOWN to reach, so a walker that stops matching fails loudly instead of
 * reporting an empty, vacuously-passing set.
 *
 * That limit is not theoretical. THREE run-start routes hid behind it:
 *
 *   • `POST /api/briefing/run-now` — two cross-file hops
 *     (`triggerBriefingRunNow` → `runBriefingForUser` → `.streamChat(`), no
 *     primitive anywhere in the route file.
 *   • `POST /api/hub/pages/[id]/actions/[action]` — DYNAMIC DISPATCH into the
 *     hub-page provider registry, reaching the same trigger with no helper
 *     name in the file at all.
 *   • `POST /api/integrations/github-projects/proposals/[id]/approve` — one hop
 *     (`approveProposal` → `.streamChat(`) into the spawn bridge, which creates
 *     the conversation and launches the run fire-and-forget. Found only after
 *     the first two were closed, which is the argument for pinning hops rather
 *     than trusting a sweep.
 *
 * All three were absent from `RUN_START_ROUTES`, so "names EXACTLY the routes
 * that start a run" was passing against a list that was not exact, a
 * `lockedModeId` key could name any of them, and none wired Boundary 3. The fix
 * is to pin the ENTRY POINT as a primitive (a name the route file does contain)
 * and to assert the hops themselves, which is the only form that survives a
 * helper being renamed or a bag being dropped halfway down.
 *
 * ── What is deliberately OUT, and why ─────────────────────────────────
 * The set is "routes that START a run", not "routes that can cause an LLM to
 * execute". Three families sit just outside it, recorded here so the next
 * reader does not have to re-derive the line — or mistake a decision for an
 * omission:
 *
 *   • **Routes that ADVANCE a run somebody else started.**
 *     `POST /api/workflows/runs/[id]/resume` reaches `runAgent`
 *     (`resumeParkedRun` → `resumeClaimedRun` → `executor.resumeWorkflow`), but
 *     it starts nothing: the run must already exist and be `suspended`, and
 *     `mayControl` limits the caller to their own runs (or admin). That is the
 *     same shape as `POST /api/tool-calls/[id]/permission`, which answers a
 *     pending gate and so causes a `shell` call to execute — and which the
 *     `desktop-companion` bundle GRANTS on purpose. A confined key is expected
 *     to answer for the work it is driving; it is not expected to originate
 *     work. Move resume in only by moving the permission route in with it.
 *     Residual, stated: a lock-only key that owns a suspended run can advance
 *     it, and the resumed run's tool surface is not narrowed by the lock.
 *   • **Routes that simulate.** `POST /api/workflows/[name]/dry-run` calls
 *     `dryRunWorkflow`, not `.runWorkflow(` — `transform`/`gate` steps are
 *     evaluated in-process and every other step is stubbed. No LLM, no run row,
 *     so no primitive to match and nothing for a policy to confine.
 *   • **Extension-dispatch doors.** `POST /api/extensions/[name]/events/[event]`,
 *     `POST /api/ez-actions/[name]`, `POST /api/hooks/[extensionId]/[slug]` and
 *     `POST /api/tool-invoke` (the sandbox reverse-RPC surface, whose handlers
 *     include spawn-assignment and workflows) hand control to extension code,
 *     which — like the `.actions?.[` dispatch that IS pinned above — could in
 *     principle reach a run. The difference is the gate, not the mechanism:
 *     what an extension may do is decided per extension by its own approved
 *     permission grant (PDP), a per-install decision a route allowlist cannot
 *     re-derive, whereas the hub-page registry dispatches into FIRST-PARTY core
 *     providers with no such grant behind them. Naming these four here would
 *     confine the door and leave the grant unexamined, which is the weaker of
 *     the two controls. Consequence, stated rather than implied: a policied key
 *     reaching any of them can cause a spawn that Boundary 3 never sees, and a
 *     legacy lock-only key is not denied there — the Boundary-1 lock rule
 *     covers RUN_START_ROUTES only. Boundary 1 still bounds it, and the shipped
 *     `desktop-companion` bundle names none of these routes.
 */
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import {
  MODE_GUARDED_RUN_START_ROUTES,
  RUN_START_ROUTES,
} from "../auth/tool-policy";
import { computeReaching, declarationsOf, type Decl } from "./helpers/source-walk";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROUTES_ROOT = join(REPO_ROOT, "web/src/routes/api");

/** The HTTP verbs SvelteKit will serve from a `+server.ts`. */
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Source tokens that START A RUN.
 *
 * Method-qualified (`.streamChat(`, not `streamChat(`) where the call is
 * always made on an executor, so a local variable that merely shares the name
 * cannot seed the walk. `startAssignment` and `spawnAssignment` are bare
 * because both are imported functions called directly.
 */
const RUN_START_PRIMITIVES = [
  ".streamChat(",
  ".runAgent(",
  ".runWorkflow(",
  "startAssignment(",
  "spawnAssignment(",
  // Two hops to a run and neither of them intra-file, which is why this list
  // has to name the ENTRY POINT rather than the primitive:
  // `triggerBriefingRunNow` → `runBriefingForUser` → `executor.streamChat`.
  // `POST /api/briefing/run-now` was therefore invisible to this walk and
  // absent from RUN_START_ROUTES — so `validateToolPolicy` accepted a
  // `lockedModeId` policy that named it, and the "names EXACTLY the routes
  // that start a run" assertion below was passing on a false list. Pinned in
  // "the cross-file hops are real".
  "triggerBriefingRunNow(",
  // The hub actions route reaches the SAME trigger by DYNAMIC DISPATCH
  // (`provider?.actions?.[actionName]`), so no run primitive and no helper
  // name appears in that file at all. The dispatch expression is the only
  // token there is; a registry whose members can start runs makes every
  // dispatch into it a run start. Closing run-now alone would have left this
  // door open — one bypass is all a boundary needs.
  ".actions?.[",
  // The github-projects approve route: one cross-file hop to the spawn bridge,
  // which creates the conversation and launches `executor.streamChat`
  // fire-and-forget. Same shape as the briefing trigger, so the same treatment
  // — pin the ENTRY POINT, which is the only name this route file contains.
  // It is the run this walk could least afford to miss: the spawn's permission
  // mode defaults to `yolo` and it sets no `toolRestriction`, and the route is
  // `requireScope + requireAuth` (a Bearer key reaches it), so Boundary 3 was
  // the only layer that could have applied and it was unwired. Hops pinned in
  // "the cross-file hops are real".
  "approveProposal(",
] as const;

/**
 * The primitives that reach a run which TAKES a per-run tool-policy option bag.
 * `runAgent`, `runWorkflow` and `startAssignment` have no such parameter, so
 * Boundary 3 cannot be wired into them and Boundary 1 (the route allowlist)
 * plus the mint-time refusal below are the controls on those routes.
 *
 * The two briefing entries DO reach one — `runBriefingForUser` threads the bag
 * into `streamChat` — so they owe the wiring exactly as the three direct
 * `streamChat` routes do, and are asserted here rather than exempted for being
 * indirect. `approveProposal` likewise: its `ApproveDeps` argument is already an
 * injection seam, so the bag rides down it into the spawn bridge's own
 * `streamChat`.
 */
const B3_CAPABLE_PRIMITIVES = [
  ".streamChat(",
  "triggerBriefingRunNow(",
  ".actions?.[",
  "approveProposal(",
] as const;

/** The Boundary-3 derivation every {@link B3_CAPABLE_PRIMITIVES} route must
 *  call — at the ROUTE, even when the run itself is two hops away. */
const B3_WIRING = "runStartToolPolicyOptions(";

/** The Boundary-2 guard every mode-guarded route must call. */
const B2_GUARD = "runStartPolicyDenial(";

/**
 * Routes this analysis is KNOWN to reach, one per primitive shape. Guards
 * against a walker that stops matching and reports an empty, vacuously
 * passing result set.
 */
const MUST_DETECT = [
  "POST /api/conversations/[id]/messages", // .streamChat(
  "POST /api/agents/[name]/run", // .runAgent(
  "POST /api/workflows/[name]/run", // .runWorkflow(
  "POST /api/conversations/[id]/tasks/[taskId]/retry", // startAssignment(
  "POST /api/briefing/run-now", // triggerBriefingRunNow(
  "POST /api/hub/pages/[id]/actions/[action]", // .actions?.[
  "POST /api/integrations/github-projects/proposals/[id]/approve", // approveProposal(
] as const;

interface RouteAnalysis {
  /** `"POST /api/conversations/[id]/messages"`. */
  key: string;
  routeId: string;
  method: string;
  /** Path relative to the repo root, for failure messages. */
  path: string;
  decls: Map<string, Decl>;
  /** The verb declaration's own body plus every declaration it reaches. */
  reachedText: string;
}

/** `conversations/[id]/messages/+server.ts` → `/api/conversations/[id]/messages`. */
function routeIdFor(relPath: string): string {
  const dir = relPath.slice(0, -"/+server.ts".length);
  return dir === "" ? "/api" : `/api/${dir}`;
}

/**
 * Every run-starting (method, route) pair the tree actually contains.
 *
 * Attribution is PER VERB, not per file: `messages/+server.ts` exports both
 * GET and POST and only POST starts a run. A file-level answer would put
 * `GET …/messages` in the run-start set and then refuse to mint a read-only
 * locked key that names it — a false positive with a real cost.
 */
async function analyzeRoutes(): Promise<RouteAnalysis[]> {
  const glob = new Glob("**/+server.ts");
  const out: RouteAnalysis[] = [];
  for await (const rel of glob.scan({ cwd: ROUTES_ROOT, absolute: false })) {
    const decls = await declarationsOf(join(ROUTES_ROOT, rel));
    const reaching = computeReaching(decls, RUN_START_PRIMITIVES);
    for (const method of VERBS) {
      if (!reaching.has(method)) continue;
      // The verb's own body plus every declaration it reaches, so a wiring
      // token in the helper the verb delegates to still counts.
      const reachedText = [...reaching]
        .map((name) => decls.get(name)?.body ?? "")
        .join("\n");
      out.push({
        key: `${method} ${routeIdFor(rel)}`,
        routeId: routeIdFor(rel),
        method,
        path: `web/src/routes/api/${rel}`,
        decls,
        reachedText,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const routes = await analyzeRoutes();
const derived = routes.map((r) => r.key);

describe("RUN_START_ROUTES — tree-wide run-start surface assertion", () => {
  test("the walker actually parsed the route tree", () => {
    // Cheap structural sanity BEFORE any set assertion, so a glob that
    // matched nothing cannot read as a pass.
    expect(routes.length).toBeGreaterThan(3);
  });

  test("the detector is alive — it rediscovers every known run-start route", () => {
    const missed = MUST_DETECT.filter((key) => !derived.includes(key));
    expect(missed).toEqual([]);
  });

  test("RUN_START_ROUTES names EXACTLY the routes that start a run", () => {
    // A failure in the MISSING direction is a SECURITY FINDING: the named
    // route starts a run, and a `lockedModeId` key may name it in a
    // routeAllowlist without `validateToolPolicy` ever consulting the lock.
    // A failure in the STALE direction is a rotted list — the route no longer
    // starts a run, so the mint refusal it causes is now spurious.
    expect(derived).toEqual([...RUN_START_ROUTES].sort());
  });

  test("every mode-guarded route is a run-start route that CALLS the guard", () => {
    // The claim `MODE_GUARDED_RUN_START_ROUTES` makes about itself, asserted
    // against the handler rather than against a comment. `tool-policy.ts`
    // promised this test existed; it did not.
    for (const key of MODE_GUARDED_RUN_START_ROUTES) {
      const route = routes.find((r) => r.key === key);
      expect({ key, found: route !== undefined }).toEqual({ key, found: true });
      expect({ key, guarded: route?.reachedText.includes(B2_GUARD) }).toEqual({
        key,
        guarded: true,
      });
    }
  });

  test("MODE_GUARDED_RUN_START_ROUTES names EXACTLY the run-start routes that call the guard", () => {
    // BOTH directions, derived — the subset check above is the direction that
    // cannot detect the failure that matters. A route that WIRES the guard but
    // is missing from the list keeps refusing locked mints it could now serve
    // (the non-monotonic shape this fix removes); a route ON the list that
    // stopped calling the guard is a lock that silently does nothing.
    //
    // The set was ONE route while four conversation-scoped run-start routes
    // ran no guard at all. A `lockedModeId` key could not name them — but a key
    // with NO allowlist reached every one of them, because `validateToolPolicy`
    // derived reach from the allowlist it did not have.
    const derivedGuarded = routes
      .filter((r) => r.reachedText.includes(B2_GUARD))
      .map((r) => r.key);
    expect(derivedGuarded).toEqual([...MODE_GUARDED_RUN_START_ROUTES].sort());
  });

  test("the unguardable routes are exactly the ones with no conversation to read", () => {
    // Pinned as the COMPLEMENT, so shrinking the guarded set has to be a
    // deliberate edit here. `runAgent` / `runWorkflow` start a run with no
    // conversation to read a `mode_id` from; the two briefing entries and the
    // github-projects approve route CREATE the conversation their run executes
    // on, so its persisted mode is a row that does not exist when a guard would
    // run and `mayUseMode` would read a constant `null`. A lock is not
    // enforceable on any of the five even in principle — which is why a lock
    // may never REACH one: not with an absent routeAllowlist (which reaches all
    // of them), and not by naming one in an allowlist. Both at mint, and both
    // at Boundary 1, where `lockedModeRunStartDenial` denies exactly this
    // complement for a lock that carries an allowlist.
    const guarded = new Set(MODE_GUARDED_RUN_START_ROUTES);
    expect(RUN_START_ROUTES.filter((r) => !guarded.has(r))).toEqual([
      "POST /api/agents/[name]/run",
      "POST /api/briefing/run-now",
      "POST /api/hub/pages/[id]/actions/[action]",
      "POST /api/integrations/github-projects/proposals/[id]/approve",
      "POST /api/workflows/[name]/run",
    ]);
  });

  test("EVERY run-start route that CAN carry Boundary 3 wires it", () => {
    // The assertion that would have failed on the shipped code — twice. All
    // three `streamChat` routes called `streamChat` with no policy options at
    // all, so a policied key's spawn-deny and caller-tool cap were inert
    // mid-turn; and both briefing entries reached the same executor two hops
    // away with nothing to pass.
    const unwired = routes
      .filter((r) => B3_CAPABLE_PRIMITIVES.some((p) => r.reachedText.includes(p)))
      .filter((r) => !r.reachedText.includes(B3_WIRING))
      .map((r) => `${r.key} — ${r.path}`);
    expect(unwired).toEqual([]);
  });

  test("the Boundary-3-capable routes are the six we think they are", () => {
    // Pinned separately so that a route DROPPING its run call (and with it,
    // silently, the Boundary-3 assertion above) fails here rather than
    // shrinking the set the previous test iterates. An empty filter passes
    // that test vacuously.
    const b3Routes = routes
      .filter((r) => B3_CAPABLE_PRIMITIVES.some((p) => r.reachedText.includes(p)))
      .map((r) => r.key);
    expect(b3Routes).toEqual([
      "POST /api/briefing/run-now",
      "POST /api/conversations/[id]/agent-chat",
      "POST /api/conversations/[id]/messages",
      "POST /api/conversations/[id]/messages/[mid]/retry",
      "POST /api/hub/pages/[id]/actions/[action]",
      "POST /api/integrations/github-projects/proposals/[id]/approve",
    ]);
  });

  test("the cross-file hops are real", async () => {
    // `startAssignment` is treated as a primitive because of one hop the
    // intra-file walker cannot follow. Pin it, so removing the hop forces the
    // primitive list to be revisited rather than leaving it silently
    // justified by nothing.
    const startAssignment = await Bun.file(
      join(REPO_ROOT, "src/runtime/start-assignment.ts"),
    ).text();
    expect(startAssignment).toContain("executor.streamChat(");

    // `.runWorkflow(` reaches a run through the workflow executor.
    const workflowExecutor = await Bun.file(
      join(REPO_ROOT, "src/runtime/workflow-executor.ts"),
    ).text();
    expect(workflowExecutor).toContain("this.agentExecutor.runAgent(");

    // `triggerBriefingRunNow` is TWO hops from the run, and the second hop is
    // where Boundary 3 either arrives or is silently dropped. Pin BOTH: the
    // trigger forwards the bag it was given, and the pipeline spreads it into
    // the `streamChat` call. Wiring the route and losing the options in the
    // middle is the exact half-wiring shape this suite exists to catch, and it
    // is invisible from the route side alone.
    const trigger = await Bun.file(
      join(REPO_ROOT, "web/src/lib/server/briefing-run-now.ts"),
    ).text();
    expect(trigger).toContain("runBriefingForUser(config, { toolPolicyOptions })");

    const briefingRun = await Bun.file(join(REPO_ROOT, "src/runtime/briefing/run.ts")).text();
    expect(briefingRun).toContain(".streamChat(");
    expect(briefingRun).toContain("...(opts.toolPolicyOptions ?? {})");

    // The hub dispatch hop: the actions route hands the bag to a provider
    // action, and the ONE core action that starts a run forwards it to the
    // same trigger. Without this line the tab is a second, unconfined door to
    // the run-now pipeline.
    const briefingHubPage = await Bun.file(
      join(REPO_ROOT, "src/runtime/briefing/hub-page.ts"),
    ).text();
    expect(briefingHubPage).toContain("deps.triggerRunNow(ctx.userId, ctx.toolPolicyOptions)");

    // `approveProposal` is ONE hop from the run, and the hop is where the
    // route's bag either arrives at the executor or is silently dropped. The
    // route side can only show that a bag was BUILT; this shows it is spread
    // into the very `streamChat` call that starts the spawned run.
    const ghSpawn = await Bun.file(
      join(REPO_ROOT, "src/integrations/github-projects/spawn.ts"),
    ).text();
    expect(ghSpawn).toContain(".streamChat(");
    expect(ghSpawn).toContain("...(deps.toolPolicyOptions ?? {})");
  });

  test("a run-start route is never confused with a plain read on the same file", () => {
    // Per-verb attribution, asserted directly: `messages/+server.ts` exports
    // GET and POST, and only POST starts a run. Were attribution per FILE,
    // `GET …/messages` would land in RUN_START_ROUTES and every locked key
    // that reads its own messages would be unmintable.
    expect(derived).toContain("POST /api/conversations/[id]/messages");
    expect(derived).not.toContain("GET /api/conversations/[id]/messages");
  });
});
