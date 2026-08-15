/**
 * §2.4 — the TREE-WIDE static assertion that keeps `POLICY_LEAF_SPAWN_DENY`
 * honest.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A HAND LIST. The previous revision of
 * this policy grepped its deny set out of ONE file and then asserted that set
 * over the whole tool surface. It shipped a hole: `ez-code__dispatch_run`
 * spawns a sub-agent, was absent from the set, and auto-wires from a single
 * `![ext:ez-code]` mention. A list maintained by the author of the list cannot
 * catch the tool the author did not think of.
 *
 * So the expectation here is DERIVED FROM THE SOURCE. This suite walks every
 * tool handler under `docs/extensions/examples/**`, `extensions/**` and
 * `src/runtime/tools/**`, propagates reachability to the spawn/run-start
 * primitives, and fails when a reaching tool is missing from the set. Running
 * it for the first time found two more:
 *
 *   • `docs-updater__run_docs_update` — a loop MANUAL TRIGGER. The SDK turns
 *     `{ kind: "manual", tool: "run_docs_update" }` into a real LLM-callable
 *     ToolHandler (`sdk/src/runtime/loop.ts:433-476`) that runs the loop's
 *     `check` → `act`; that act calls `ctx.spawn` (`docs-updater/index.ts:538`).
 *     The tool name and the spawn are ~500 lines and one indirection apart,
 *     which is precisely why no call-site grep would ever pair them.
 *   • `test-spawn-assignment__spawn_one` — calls `spawnAssignment` directly.
 *
 * ── The analysis ──────────────────────────────────────────────────────
 * Deliberately syntactic and deliberately OVER-approximating. Every
 * imprecision is chosen to fail toward "this tool reaches spawn", because a
 * false positive costs one deny-set entry and a false negative costs the
 * boundary.
 *
 *   1. Segment each file into TOP-LEVEL declarations by line: a declaration
 *      owns every line from its own to the line before the next top-level
 *      declaration. No brace matching (nothing to get wrong on a `"{"` inside
 *      a string), and a nested helper is attributed to its enclosing
 *      declaration — which over-approximates, as intended.
 *   2. Seed: a declaration is SPAWNING if its lines mention a primitive.
 *   3. Propagate to a fixed point: a declaration that CALLS a spawning
 *      declaration is spawning. Module-level aliases need no special case —
 *      `let spawn: SpawnFn = spawnAssignment` is just a declaration that
 *      mentions a primitive, so `spawn(` propagates like any other call.
 *   4. Bind tool names to handlers two ways: the `Record<string, ToolHandler>`
 *      / `createToolDispatcher({…})` maps, and the loop manual triggers.
 *
 * ── The dead-detector guard ───────────────────────────────────────────
 * A static analysis that silently stops matching is a false green, and it
 * would look exactly like success. {@link MUST_DETECT} pins the tools this
 * analysis is KNOWN to reach; if the walker breaks, that assertion fails
 * before the subset assertion can pass vacuously.
 *
 * ── §2.5, the assignment cascade: NOT guarded, and why ────────────────
 * `unblockReadyDependents` → `runSpawnForAssignment`
 * (`task-tracking/index.ts:1411`, `:1427`) spawns with no tool call and no
 * HTTP request. It is called from exactly ONE place — `applyAssignmentUpdate`
 * (`:1506`), the `task:assignment_update` subscription — and only for
 * `incoming.status === "completed"`, i.e. when a real sub-agent run finished.
 * An initiating-principal check at `spawnAssignment` is NOT implemented, for
 * two independent reasons:
 *
 *   1. There is no principal to check. `SpawnAssignmentContext`
 *      (`src/extensions/spawn-assignment-handler.ts:60-115`) carries
 *      `userId` / `conversationId` / `projectId` / `spawnDepth` — no
 *      credential. The cascade's RPC is driven by a CHILD RUN COMPLETING,
 *      so at that moment no HTTP request is in flight and no API key is
 *      attributable to it even in principle.
 *   2. It is unreachable by a confined key. Reaching the cascade needs an
 *      assignment to exist AND complete. Boundary 3 denies every tool that
 *      creates or spawns one (`task_plan` / `task_add` / `task_assign` /
 *      `task_resume`), and Boundary 1 denies the task, agent and workflow
 *      routes. The KEPT `task_complete` does not drive it either: it
 *      terminates assignments in memory via `terminateRunningAssignments`
 *      (`:286-315`), which never calls `emitAssignmentUpdate`, and the local
 *      assignment is already terminal, so `applyAssignmentUpdate`'s
 *      idempotency guard (`:1487`) returns before the cascade line. A bundle
 *      that DOES include the task routes has been handed the task surface on
 *      purpose, and the cascade is that surface working as designed.
 *
 * The owner's own activity still drives the cascade, which is the documented
 * scope of the whole feature: policy binds the key, never the owner.
 */
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { join, relative } from "node:path";
import { POLICY_LEAF_SPAWN_DENY } from "../runtime/tools/filter";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Trees whose tool handlers are LLM-callable and therefore in scope. */
const SCANNED_TREES = [
  "docs/extensions/examples",
  "extensions",
  "src/runtime/tools",
] as const;

/**
 * Source tokens that ARE (or transitively are) a spawn / run-start.
 *
 * `.runWorkflow(` and `.runAgent(` are the two cross-file hops. A hop the
 * intra-file walker cannot see is a hole unless the hop itself is pinned, so
 * {@link "the cross-file hops are real"} asserts each one still exists in the
 * module it points at. `ctx.spawn(` is the loop-context spawn, typed
 * `typeof spawnAssignment` — also pinned below.
 */
const SPAWN_PRIMITIVES = [
  "spawnAssignment",
  "attemptSpawn",
  "runSpawnForAssignment",
  "ctx.spawn(",
  ".runAgent(",
  ".runWorkflow(",
] as const;

/**
 * Tools this analysis is KNOWN to reach. Guards against a walker that stops
 * matching and reports an empty, vacuously-passing result set.
 */
const MUST_DETECT = [
  "invoke_agent",
  "send_to_agent",
  "task_plan",
  "task_add",
  "task_assign",
  "task_resume",
  "dispatch_run",
  "run_docs_update",
  "spawn_one",
  "run_workflow",
] as const;

interface Decl {
  name: string;
  /** Every source line this declaration owns, joined. */
  body: string;
}

interface FileAnalysis {
  path: string;
  decls: Map<string, Decl>;
  /** Declaration names that reach a spawn primitive. */
  spawning: Set<string>;
  /** tool name → handler declaration name. */
  toolBindings: Map<string, string>;
  /** Manual-trigger `tool:` values whose name could not be resolved. */
  unresolvedManualTools: string[];
}

/** A top-level declaration opener, anchored at column 0. */
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * `[<(]`, not `(` — `defineLoop<DocsInput, DocsOutcome>({…})` is a GENERIC
 * call, and matching a literal `defineLoop(` silently skipped the one
 * extension in the tree whose loop spawns. The dead-detector guard is what
 * caught that; keep both forms.
 */
const CALLS_DEFINE_LOOP = /\bdefineLoop\s*[<(]/;
const CALLS_DISPATCHER = /\bcreateToolDispatcher\s*[<(]/;

/**
 * `Bun.spawn` is a PROCESS spawn, not a run spawn. Erased before matching so
 * a file that shells out cannot be dragged in through a `spawn(` substring.
 */
function eraseProcessSpawns(source: string): string {
  return source.replaceAll("Bun.spawn", "Bun.__process_spawn__");
}

/**
 * Blank every comment, preserving line count so a declaration's span is
 * unchanged.
 *
 * NOT cosmetic — comments were the first thing this analysis got wrong, and
 * in the direction that matters least but is loudest. `task_complete` and
 * `task_stop` both read as spawn-reaching on the strength of a doc comment
 * saying the words "fire `spawnAssignment` for newly-unblocked dependents",
 * which would have forced two deliberately-KEPT tools into the deny set on
 * the authority of prose. Segmentation makes it worse: a doc comment sits
 * ABOVE the declaration it documents, so it is attributed to the PREVIOUS
 * one — `stopHandler` inherited `resumeHandler`'s.
 *
 * Character-scanned rather than regex-replaced, so a `//` inside a string
 * (`"https://…"`) and a `/*` inside a template literal are left alone.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  // "code" | "line" | "block" | the quote char of the string being scanned
  let state: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") state = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      // Newlines survive so line numbers and declaration spans hold.
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string literal: copy verbatim, honour escapes, close on the
    // matching quote.
    if (ch === "\\") {
      out += ch + (next ?? "");
      i += 2;
      continue;
    }
    if (ch === state) state = "code";
    out += ch;
    i += 1;
  }
  return out;
}

function segmentDeclarations(source: string): Map<string, Decl> {
  const lines = source.split("\n");
  const decls = new Map<string, Decl>();
  let current: { name: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    // A re-declared name (a `let x` reassigned in a later top-level
    // statement) merges rather than replaces — losing either half would lose
    // reachability.
    const previous = decls.get(current.name);
    const body = current.lines.join("\n");
    decls.set(current.name, {
      name: current.name,
      body: previous ? `${previous.body}\n${body}` : body,
    });
  };
  for (const line of lines) {
    const match = TOP_LEVEL_DECL.exec(line);
    if (match?.[1]) {
      flush();
      current = { name: match[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return decls;
}

/** True when `body` calls `name` — call-shaped, so a bare mention of a
 *  common identifier cannot create a false edge. */
function callsDeclaration(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(body);
}

function computeSpawning(decls: Map<string, Decl>): Set<string> {
  const spawning = new Set<string>();
  for (const decl of decls.values()) {
    if (SPAWN_PRIMITIVES.some((p) => decl.body.includes(p))) spawning.add(decl.name);
  }
  // Fixed point. Bounded by the declaration count: each pass either adds a
  // declaration or stops.
  let changed = true;
  while (changed) {
    changed = false;
    for (const decl of decls.values()) {
      if (spawning.has(decl.name)) continue;
      for (const target of spawning) {
        if (target === decl.name) continue;
        if (callsDeclaration(decl.body, target)) {
          spawning.add(decl.name);
          changed = true;
          break;
        }
      }
    }
  }
  return spawning;
}

/** Top-level `const NAME = "literal"` values, for `tool: PING_TOOL` forms. */
function stringConstants(decls: Map<string, Decl>): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of decls.values()) {
    const m = new RegExp(
      `^(?:export\\s+)?(?:const|let)\\s+${decl.name}\\s*(?::[^=]+)?=\\s*["'\`]([^"'\`]+)["'\`]`,
    ).exec(decl.body);
    if (m?.[1]) out.set(decl.name, m[1]);
  }
  return out;
}

/**
 * Bind tool names to handler declarations.
 *
 * Two shapes, because the tree uses two:
 *   • a handler map — any declaration typed `Record<string, ToolHandler>` or
 *     handed to `createToolDispatcher({…})` — read as `tool_name: handler`;
 *   • a loop manual trigger — `{ kind: "manual", tool: "X" }` inside a
 *     `defineLoop(` declaration binds X to that loop's `act:` handler.
 */
function extractToolBindings(
  decls: Map<string, Decl>,
  consts: Map<string, string>,
): { bindings: Map<string, string>; unresolved: string[] } {
  const bindings = new Map<string, string>();
  const unresolved: string[] = [];

  for (const decl of decls.values()) {
    const isHandlerMap =
      decl.body.includes("ToolHandler>") || CALLS_DISPATCHER.test(decl.body);
    if (isHandlerMap) {
      for (const m of decl.body.matchAll(/^\s{2,}([a-z][a-z0-9_]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,/gm)) {
        const [, toolName, handler] = m;
        if (toolName && handler) bindings.set(toolName, handler);
      }
    }

    if (!CALLS_DEFINE_LOOP.test(decl.body)) continue;
    // The loop's act handler. `act:` may name an identifier or be inline; an
    // inline arrow belongs to THIS declaration, which is what the fallback
    // below attributes it to.
    const actMatch = /\bact\s*:\s*([A-Za-z_$][\w$]*)\s*,/.exec(decl.body);
    const actHandler = actMatch?.[1] ?? decl.name;
    for (const m of decl.body.matchAll(
      /kind\s*:\s*["']manual["'][^}]*?\btool\s*:\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*))/g,
    )) {
      const literal = m[1];
      const ident = m[2];
      const resolved = literal ?? (ident ? consts.get(ident) : undefined);
      if (resolved === undefined) {
        if (ident !== undefined) unresolved.push(ident);
        continue;
      }
      bindings.set(resolved, actHandler);
    }
  }
  return { bindings, unresolved };
}

/**
 * Builtin tool defs are object literals inside a factory, not a handler map:
 * `{ name: RUN_WORKFLOW_TOOL_NAME, …, execute: … }`. Any tool name a SPAWNING
 * declaration names is treated as that declaration's tool.
 */
function builtinToolNames(decl: Decl, consts: Map<string, string>): string[] {
  const names: string[] = [];
  for (const m of decl.body.matchAll(
    /^\s*name\s*:\s*(?:["'`]([a-z][a-z0-9_]*)["'`]|([A-Z][A-Z0-9_]*))\s*,/gm,
  )) {
    const literal = m[1];
    const ident = m[2];
    const resolved = literal ?? (ident ? consts.get(ident) : undefined);
    if (resolved !== undefined) names.push(resolved);
  }
  return names;
}

async function analyzeFile(absPath: string): Promise<FileAnalysis> {
  const source = eraseProcessSpawns(stripComments(await Bun.file(absPath).text()));
  const decls = segmentDeclarations(source);
  const consts = stringConstants(decls);
  const spawning = computeSpawning(decls);
  const { bindings, unresolved } = extractToolBindings(decls, consts);

  // Builtin defs: a spawning factory owns the tool names it declares.
  for (const declName of spawning) {
    const decl = decls.get(declName);
    if (!decl) continue;
    for (const toolName of builtinToolNames(decl, consts)) {
      if (!bindings.has(toolName)) bindings.set(toolName, declName);
    }
  }

  return {
    path: relative(REPO_ROOT, absPath),
    decls,
    spawning,
    toolBindings: bindings,
    unresolvedManualTools: unresolved,
  };
}

async function analyzeTree(): Promise<FileAnalysis[]> {
  const glob = new Glob("**/*.ts");
  const out: FileAnalysis[] = [];
  for (const tree of SCANNED_TREES) {
    const root = join(REPO_ROOT, tree);
    for await (const rel of glob.scan({ cwd: root, absolute: false })) {
      if (
        rel.endsWith(".test.ts") ||
        rel.endsWith(".d.ts") ||
        rel.includes("__tests__/") ||
        rel.includes("node_modules/")
      ) {
        continue;
      }
      out.push(await analyzeFile(join(root, rel)));
    }
  }
  return out;
}

/** Every tool name that reaches a spawn primitive → the file that proves it. */
function reachingTools(files: FileAnalysis[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const [toolName, handler] of file.toolBindings) {
      if (file.spawning.has(handler)) found.set(toolName, `${file.path} (${handler})`);
    }
  }
  return found;
}

const analysis = await analyzeTree();
const reaching = reachingTools(analysis);

describe("POLICY_LEAF_SPAWN_DENY — tree-wide spawn-surface assertion (§2.4)", () => {
  test("the walker actually parsed the tree", () => {
    // Cheap structural sanity BEFORE any set assertion, so a glob that
    // matched nothing cannot read as a pass.
    expect(analysis.length).toBeGreaterThan(50);
    const withTools = analysis.filter((f) => f.toolBindings.size > 0);
    expect(withTools.length).toBeGreaterThan(5);
  });

  test("the detector is alive — it rediscovers every known spawn-reaching tool", () => {
    const missed = MUST_DETECT.filter((name) => !reaching.has(name));
    expect(missed).toEqual([]);
  });

  test("EVERY tool that reaches a spawn primitive is in POLICY_LEAF_SPAWN_DENY", () => {
    const escaped = [...reaching.entries()]
      .filter(([toolName]) => !POLICY_LEAF_SPAWN_DENY.has(toolName))
      .map(([toolName, where]) => `${toolName} — ${where}`)
      .sort();
    // A failure here is a SECURITY FINDING, not a chore: the named tool can
    // start an agent run and a confined key can currently call it. Add it to
    // POLICY_LEAF_SPAWN_DENY (src/runtime/tools/filter.ts) and say so loudly.
    expect(escaped).toEqual([]);
  });

  test("the two extensions found by this analysis are still covered", () => {
    // Pinned separately from MUST_DETECT: these two are the reason the
    // analysis exists, so their loss must name itself in the failure output
    // rather than hiding in a list of ten.
    expect(reaching.get("run_docs_update") ?? "NOT DETECTED").toContain("docs-updater");
    expect(POLICY_LEAF_SPAWN_DENY.has("run_docs_update")).toBe(true);
    expect(reaching.get("spawn_one") ?? "NOT DETECTED").toContain("test-spawn-assignment");
    expect(POLICY_LEAF_SPAWN_DENY.has("spawn_one")).toBe(true);
  });

  test("every loop manual trigger resolves to a tool name", () => {
    // An unresolved `tool: SOME_IDENT` is a tool this analysis cannot see,
    // which is the shape of the next miss.
    const unresolved = analysis
      .filter((f) => f.unresolvedManualTools.length > 0)
      .map((f) => `${f.path}: ${f.unresolvedManualTools.join(", ")}`);
    expect(unresolved).toEqual([]);
  });

  test("the cross-file hops are real", async () => {
    // `.runWorkflow(` and `ctx.spawn(` are treated as primitives because of
    // one hop each that the intra-file walker cannot follow. Pin both, so
    // removing a hop forces the primitive list to be revisited rather than
    // leaving it silently over-broad or (worse) justified by nothing.
    const workflowExecutor = await Bun.file(
      join(REPO_ROOT, "src/runtime/workflow-executor.ts"),
    ).text();
    expect(workflowExecutor).toContain("this.agentExecutor.runAgent(");

    const loopTypes = await Bun.file(
      join(REPO_ROOT, "packages/@ezcorp/sdk/src/runtime/loop-types.ts"),
    ).text();
    expect(loopTypes).toContain("spawn: typeof spawnAssignment");

    // And the manual-trigger indirection itself: a `tool` on a manual trigger
    // becomes a real ToolHandler that runs the loop's act.
    const loopSdk = await Bun.file(
      join(REPO_ROOT, "packages/@ezcorp/sdk/src/runtime/loop.ts"),
    ).text();
    expect(loopSdk).toContain("loopToolHandlers[trigger.tool] = handler");
  });

  test("the deliberately-KEPT task tools do not reach a spawn primitive", () => {
    // The set's design claim, asserted rather than asserted-in-a-comment: a
    // leaf key keeps solo bookkeeping. If `task_complete` ever starts
    // reaching a spawn, this fails BEFORE the subset test, naming the tool.
    for (const kept of ["task_start", "task_complete", "task_fail", "task_list"]) {
      expect({ tool: kept, reaches: reaching.get(kept) ?? null }).toEqual({
        tool: kept,
        reaches: null,
      });
      expect(POLICY_LEAF_SPAWN_DENY.has(kept)).toBe(false);
    }
  });
});
