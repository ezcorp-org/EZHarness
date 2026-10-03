// @ezcorp-host-integration
const fixtureImportMeta = { dir: import.meta.dir, dirname: import.meta.dir, url: import.meta.url };
/**
 * sample-loop — "TRY IT" smoke test / hands-on demo.
 *
 * A REPEATABLE way to watch the Loop SDK primitive work end-to-end. Run:
 *
 *     bun test ./docs/extensions/examples/sample-loop/try-loop.test.ts
 *
 * It spawns the reference `sample-loop` extension through the REAL
 * `ExtensionProcess` transport (production sandbox-preload), fires a
 * `run:complete` event as if a chat just finished, and then prints a
 * human-readable trace of what `defineLoop` did:
 *   1. the event fires the loop's `act`,
 *   2. the host-brokered LLM produces a one-line summary,
 *   3. the primitive persists a run record (per-run + index keys, NOT a
 *      packed blob) via `ezcorp/storage`,
 *   4. the `log.artifact` mirror writes the summary to a git-legible
 *      `.ezcorp/extension-data/summarize/summaries/<runId>.md`.
 *
 * It also ASSERTS each step, so it doubles as a real regression test. The
 * console trace is the "demo"; the `expect`s are the test. Deterministic —
 * the host harness returns fixed messages + summary, so re-runs are stable.
 *
 * (The terser CI cousin is `index.integration.test.ts`; this file is the
 * one to eyeball when you want to SEE the loop run.)
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, readFileSync } from "fs";

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import { restoreModuleMocks } from "@ezcorp/sdk/test";
import { buildHarnessEnv } from "@ezcorp/sdk/test";
import { sampleLoopHost } from "../../../../src/__tests__/helpers/sample-loop-harness";

const ENTRYPOINT = join(fixtureImportMeta.dir, "index.ts");

// What the (mocked) host LLM returns — pick something readable so the trace
// looks like a real summary.
const FAKE_SUMMARY =
  "The user asked how to rotate API keys; the assistant walked through the dashboard flow and the 24h grace window.";
// The conversation the (mocked) host hands back for the finished chat.
const FAKE_MESSAGES = [
  { id: "m1", role: "user", content: "How do I rotate my API keys without downtime?" },
  { id: "m2", role: "assistant", content: "Open Settings → Keys, click Rotate; the old key keeps working for 24h." },
  { id: "m3", role: "user", content: "Perfect, thanks." },
];

describe("sample-loop — TRY IT (hands-on demo)", () => {
  let proc: ExtensionProcess | undefined;
  let state: ReturnType<typeof sampleLoopHost>;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `try-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projectRoot, ".ezcorp", "extension-data"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    state = sampleLoopHost(projectRoot, FAKE_SUMMARY, "demo-model", FAKE_MESSAGES);
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnWired(): ExtensionProcess {
    const extId = "sample-loop-" + Math.random().toString(36).slice(2, 8);
    const env = buildHarnessEnv(extId, { filesystem: true });
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, { persistent: true, callTimeoutMs: 15_000 });
    p.setRequestHandler(state.handleRequest);
    return p;
  }

  test("a finished chat fires the loop → summary run persisted + artifact mirrored", async () => {
    const log = (...a: unknown[]) => console.log("   ", ...a);
    console.log("\n┌─ TRY THE LOOP ───────────────────────────────────────────");
    log("sample-loop: on every run:complete, summarize the chat in one line.");

    proc = spawnWired();
    expect((await proc.call("tools/list")).error).toEqual({ code: -32601, message: "Method not found: tools/list" });

    const conversationId = "conv-demo-1";
    log(`▶  firing  ezcorp/event/run:complete  { conversationId: "${conversationId}" }`);
    expect(await proc.sendNotification("ezcorp/event/run:complete", { conversationId })).toBe(true);
    await state.whenComplete;

    const ids = state.kv.get("loop:summarize:index") as string[] | undefined;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids!.length).toBe(1);
    const runId = ids![0];

    // Per-run key — NOT a single packed blob (the §5 race-fix substrate).
    const run = state.kv.get(`loop:summarize:run:${runId}`) as
      | { id: string; status: string; outcome?: { summary?: string }; events?: unknown[] }
      | undefined;
    expect(run?.status).toBe("done");
    expect(run?.outcome?.summary).toBe(FAKE_SUMMARY);

    log("");
    log("✓  RUN PERSISTED (Storage, per-run key)");
    log(`     key      loop:summarize:run:${runId}`);
    log(`     index    loop:summarize:index = [${runId}]`);
    log(`     status   ${run?.status}`);
    log(`     events   ${run?.events?.length ?? 0}`);
    log(`     summary  "${run?.outcome?.summary}"`);

    // Artifact mirror.
    const file = join(projectRoot, ".ezcorp", "extension-data", "summarize", "summaries", `${runId}.md`);
    const body = readFileSync(file, "utf8");
    expect(body).toBeDefined();
    expect(body).toContain(FAKE_SUMMARY);

    log("");
    log("✓  ARTIFACT MIRRORED (.ezcorp/extension-data — git-legible)");
    log(`     .ezcorp/extension-data/summarize/summaries/${runId}.md`);
    for (const line of body.split("\n")) log(`     │ ${line}`);
    console.log("   ✅ loop works end-to-end.");
    console.log("└──────────────────────────────────────────────────────────\n");
  });
});
