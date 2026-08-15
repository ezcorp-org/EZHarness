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
 * ── The known limit, stated rather than hidden ────────────────────────
 * Reachability is intra-file plus PINNED cross-file hops (see "the cross-file
 * hops are real"). A future route that starts a run through some new helper
 * whose name is on neither list is invisible to this walk — the same limit
 * `policy-spawn-deny-surface.test.ts` carries, and the reason both suites
 * keep a dead-detector: {@link MUST_DETECT} pins the routes the analysis is
 * KNOWN to reach, so a walker that stops matching fails loudly instead of
 * reporting an empty, vacuously-passing set.
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
] as const;

/**
 * The primitive that takes a per-run tool-policy option bag. `runAgent`,
 * `runWorkflow` and `startAssignment` have no such parameter, so Boundary 3
 * cannot be wired into them and Boundary 1 (the route allowlist) plus the
 * mint-time refusal below are the controls on those routes.
 */
const STREAM_CHAT = ".streamChat(";

/** The Boundary-3 derivation every `streamChat` run-start route must call. */
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

  test("EVERY streamChat run-start route wires Boundary 3", () => {
    // The assertion that would have failed on the shipped code. All three
    // `streamChat` routes called it with no policy options at all, so a
    // policied key's spawn-deny and caller-tool cap were inert mid-turn.
    const unwired = routes
      .filter((r) => r.reachedText.includes(STREAM_CHAT))
      .filter((r) => !r.reachedText.includes(B3_WIRING))
      .map((r) => `${r.key} — ${r.path}`);
    expect(unwired).toEqual([]);
  });

  test("the streamChat routes are the three we think they are", () => {
    // Pinned separately so that a route DROPPING its `streamChat` call (and
    // with it, silently, the Boundary-3 assertion above) fails here rather
    // than shrinking the set the previous test iterates. An empty filter
    // passes that test vacuously.
    const streamChatRoutes = routes
      .filter((r) => r.reachedText.includes(STREAM_CHAT))
      .map((r) => r.key);
    expect(streamChatRoutes).toEqual([
      "POST /api/conversations/[id]/agent-chat",
      "POST /api/conversations/[id]/messages",
      "POST /api/conversations/[id]/messages/[mid]/retry",
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
