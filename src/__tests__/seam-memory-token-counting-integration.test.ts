// Seam 7 — Memory Injection ↔ Token Budget ↔ Downstream Usage Accounting
//
// The integration-auditor.md Seam 7 flags a concrete concern: when
// memory is injected into the chat system prompt, is the token
// overhead actually counted by the cost/billing / observability layer?
// Or does memory injection inflate the real LLM request in a way that
// the run:usage / observability aggregates never see?
//
// What actually happens in the codebase:
//
//   1. `buildSystemPromptWithMemories` (src/memory/injection.ts) runs
//      a token budget loop using an `estimateTokens(text) = length / 4`
//      heuristic to decide how many memory lines to inject. It returns
//      a single `systemPrompt` string that is `base + injectionBlock`.
//
//   2. The executor (src/runtime/executor.ts:533-534) captures the
//      returned prompt into its local `system` variable:
//          const injection = await buildSystemPromptWithMemories(...);
//          system = injection.systemPrompt;
//
//   3. That same `system` variable is what the executor passes into
//      pi-agent-core at src/runtime/executor.ts:951:
//          new Agent({ initialState: { systemPrompt: system ?? "", ... } })
//
//   4. pi-agent-core forwards the (now memory-expanded) system prompt
//      to the LLM provider, which counts every token it receives and
//      reports them back via `run:usage.usage.input`. That's the same
//      number observability persists as `tokenUsage.input` on the
//      `turn_summary` row.
//
// So the answer to "are injected tokens counted" is: yes, but ONLY
// because the injected prompt is physically concatenated before
// reaching the provider. If a future refactor ever split the injection
// out into a side-channel (e.g. a second system message, or a tool
// result, or a separate RAG pipeline) and forgot to rebuild
// `tokenUsage` with the added cost, the "user's bill silently inflates
// without anyone seeing it" problem the audit names would materialise.
//
// What this test pins — all at the injection boundary, which is the
// only place we can measure in-process without an E2E provider:
//
//   1. Base prompt vs. memory-injected prompt: the returned
//      `systemPrompt` literally contains the memory text AND is longer
//      than the base (by at least the `estimateTokens` bound per line).
//      This is the mechanical proof that injection.systemPrompt →
//      executor.system → pi-agent Agent is carrying real payload.
//
//   2. The token budget greedily fills AND respects its cap: with a
//      small budget, only the first few memories land; the rest are
//      dropped. If the budget ever regresses to unbounded injection,
//      the audit's worst case (silent bill inflation on a big project)
//      becomes possible.
//
//   3. The `memoriesUsed` report reflects exactly what was injected
//      (not what was retrieved). This is the audit-trail consumers use
//      for "why did my tokens spike this turn?" investigations.
//
// TODO (future E2E): The strict claim "run:usage.input reflects the
// injected tokens" can only be proved with a token-counting provider
// mock that scales usage with prompt length, OR a real E2E turn.
// The current pi-ai mock returns a fixed `{ input: 10, output: 5 }`
// regardless of prompt size, so an executor-level test would give a
// false negative no matter how much memory was injected. This test
// stops at the mechanical boundary (injection.systemPrompt carries the
// tokens into the system prompt sent to the Agent) and trusts the
// provider-reported count downstream. If a contributor wants to close
// the E2E gap, the right place is a new provider mock that derives
// usage from `piAgent.initialState.systemPrompt.length / 4`.

import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Real settings backed by test DB (must be before injection module import).
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(_key: string, _value: unknown) {},
    async deleteSetting(_key: string) { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

// Stub hybridSearch with a controllable result set. Each test configures
// `mockMemories` before calling buildSystemPromptWithMemories so we can
// assert exactly which memories land within the token budget.
let mockMemories: any[] = [];
mock.module("../memory/retrieval", () => ({
  hybridSearch: async () => mockMemories,
}));

mock.module("../memory/embeddings", () => {
  const dim = 384;
  const val = 1 / Math.sqrt(dim);
  return {
    generateEmbedding: async () => new Array(dim).fill(val),
    generateEmbeddings: async (texts: string[]) => texts.map(() => new Array(dim).fill(val)),
    resetEmbeddingProvider: () => {},
  };
});

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async () => ({ data: new Float32Array(384) }),
}));

const { buildSystemPromptWithMemories } = await import("../memory/injection");

// Mirror of injection.ts:20-22 — the line length heuristic used by the
// budget loop. Kept inline rather than exported to avoid coupling the
// test to an implementation detail the module chose not to publish.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function memoryLine(mem: { content: string; category: string; confidence: string }): string {
  // Matches the exact format at src/memory/injection.ts:59.
  return `- [${mem.category}] ${mem.content} (confidence: ${mem.confidence})`;
}

function makeMemory(idx: number, content: string) {
  return {
    id: `mem-${idx}`,
    content,
    category: "preferences",
    projectId: null,
    confidence: "high",
    provenance: null,
    rrfScore: 1.0 - idx * 0.01,
  };
}

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(() => {
  mockMemories = [];
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("Seam 7: memory injection token counting", () => {
  test("injection mechanically adds memory content to the system prompt passed downstream", async () => {
    // Baseline proof of the pipe: whatever tokens the injected block
    // contains will be physically sent to the LLM provider by virtue of
    // buildSystemPromptWithMemories → executor.system → pi-agent Agent.
    // If this test ever fails, step 1 of the Seam 7 chain is broken
    // and NONE of the downstream counting claims hold.
    const base = "You are a helpful assistant.";
    mockMemories = [
      makeMemory(0, "User's name is Alice"),
      makeMemory(1, "User prefers dark mode"),
    ];

    const result = await buildSystemPromptWithMemories(base, "hi", "proj-1");

    // The base is preserved verbatim at the start — nothing silently
    // elides it.
    expect(result.systemPrompt.startsWith(base)).toBe(true);
    // The injection block is strictly appended (never collapses the base).
    expect(result.systemPrompt.length).toBeGreaterThan(base.length);
    // Both memories literally appear in the returned string.
    expect(result.systemPrompt).toContain("User's name is Alice");
    expect(result.systemPrompt).toContain("User prefers dark mode");
    // And the "## Relevant Memories" header is present so the provider
    // recognises the injection as part of the system prompt, not loose
    // text. This is what proves the executor's `system` variable carries
    // the memory tokens into pi-agent-core.
    expect(result.systemPrompt).toContain("## Relevant Memories");

    // The added token count under the /4 heuristic is at LEAST the
    // sum of the two memory lines. This is the lower bound on what the
    // provider will bill for when it counts this request. Upper bound
    // is "a bit more" because the injection block also includes the
    // header + newlines.
    const lineBudget =
      estimateTokens(memoryLine({ content: "User's name is Alice", category: "preferences", confidence: "high" })) +
      estimateTokens(memoryLine({ content: "User prefers dark mode", category: "preferences", confidence: "high" }));
    const deltaTokens = estimateTokens(result.systemPrompt) - estimateTokens(base);
    expect(deltaTokens).toBeGreaterThanOrEqual(lineBudget);
  });

  test("memoriesUsed audit trail matches exactly what was injected (not what was retrieved)", async () => {
    // The `run.memoriesUsed` field (populated at executor.ts:535 from
    // `injection.memoriesUsed`) is the audit-trail consumers read when
    // asking "which memories drove this turn's cost?". It must report
    // only the memories that actually landed in the prompt, because
    // those are the ones that translate into billable tokens. If the
    // report ever drifted to "all memories retrieved" (including ones
    // the budget dropped), the trail would overcount.

    // Give the budget 8 memories, all short enough that they all fit.
    const contents = Array.from({ length: 8 }, (_, i) => `Fact number ${i}`);
    mockMemories = contents.map((c, i) => makeMemory(i, c));

    const result = await buildSystemPromptWithMemories("base", "q", "proj-1");

    expect(result.memoriesUsed).toHaveLength(8);
    for (const c of contents) {
      const found = result.memoriesUsed.find((m) => m.content === c);
      expect(found).toBeDefined();
      // systemPrompt must literally contain every reported memory — a
      // drift between memoriesUsed and systemPrompt means the trail
      // lies about what was billed.
      expect(result.systemPrompt).toContain(c);
    }
  });

  test("REGRESSION GUARD: token budget enforces a hard cap — memories beyond budget are dropped", async () => {
    // This is the Seam 7 regression guard proper. The audit's worst
    // case is "injection silently inflates the user's bill without
    // them seeing it". The only thing standing between a project with
    // 10,000 memories and a 40k-token system prompt is the budget
    // loop at src/memory/injection.ts:58-67.
    //
    // We confirm the cap is enforced by giving the function far more
    // memory content than the budget can hold, then asserting:
    //   1. The returned prompt's tokens stay under a reasonable
    //      multiple of the configured budget (rough upper bound
    //      accounting for header + base).
    //   2. Only a PREFIX of the supplied memories is injected — the
    //      rest are dropped silently. `memoriesUsed` reflects this.
    //   3. If this ever regresses to "inject everything regardless of
    //      budget", the test flips red loudly.
    //
    // If the budget loop is ever refactored (e.g. switched to a real
    // tokenizer) the constants below may drift by ±10%; that's fine —
    // loosen them, don't delete them. The direction of the assertion
    // (inject-less-than-retrieve) is the invariant.
    const budget = 200;

    // 40 memories, each ~60 chars → ~15 tokens each under length/4.
    // Budget 200 → ~13 memories max. The remaining ~27 must be dropped.
    const big = Array.from({ length: 40 }, (_, i) =>
      makeMemory(i, `Memory item ${i} with some additional padding content to give it weight`),
    );
    mockMemories = big;

    const result = await buildSystemPromptWithMemories(undefined, "q", "proj-1", {
      tokenBudget: budget,
    });

    // Cap enforced: injected lines are a strict prefix of the inputs
    // (all the first, then stop).
    expect(result.memoriesUsed.length).toBeGreaterThan(0);
    expect(result.memoriesUsed.length).toBeLessThan(big.length);
    for (let i = 0; i < result.memoriesUsed.length; i++) {
      expect(result.memoriesUsed[i]!.id).toBe(big[i]!.id);
    }
    // The later memories were NOT injected — prompt doesn't contain
    // them. Pick one that's safely past the expected cut-off.
    expect(result.systemPrompt).not.toContain("Memory item 39 with some additional padding");

    // Total memory-line tokens injected stay under budget (the loop
    // stops BEFORE adding the one that would overflow, so the
    // accumulated sum is strictly < budget + one line's worth).
    // We check a loose upper bound: total prompt tokens shouldn't
    // exceed 2× the budget once header and base are accounted for.
    expect(estimateTokens(result.systemPrompt)).toBeLessThan(budget * 2);
  });

  test("low budget → few memories → shorter prompt (monotonic budget response)", async () => {
    // Complementary to the regression guard above: verify the budget
    // is actually being read (not ignored). Two calls with the same
    // inputs but different budgets must produce different prompt
    // sizes. If they don't, the `opts.tokenBudget` parameter has been
    // silently dropped somewhere in a refactor.
    mockMemories = Array.from({ length: 20 }, (_, i) =>
      makeMemory(i, `Long memory ${i} with padding to eat budget quickly`),
    );

    const tight = await buildSystemPromptWithMemories(undefined, "q", "proj-1", { tokenBudget: 50 });
    const loose = await buildSystemPromptWithMemories(undefined, "q", "proj-1", { tokenBudget: 500 });

    expect(loose.memoriesUsed.length).toBeGreaterThan(tight.memoriesUsed.length);
    expect(loose.systemPrompt.length).toBeGreaterThan(tight.systemPrompt.length);
  });

  test("no memories retrieved → prompt unchanged → zero extra tokens carried to LLM", async () => {
    // The cost invariant for the empty case: if no memories match,
    // the returned system prompt is IDENTICAL to the base. This is
    // the "no-op cost" assertion that completes the Seam 7 story —
    // a future refactor that injected an empty "## Relevant Memories"
    // header (a few tokens) even when there's nothing to inject would
    // add cost that nothing observes.
    mockMemories = [];

    const base = "Base prompt.";
    const result = await buildSystemPromptWithMemories(base, "q", "proj-1");

    expect(result.systemPrompt).toBe(base);
    expect(result.memoriesUsed).toHaveLength(0);
    expect(estimateTokens(result.systemPrompt)).toBe(estimateTokens(base));
  });
});
