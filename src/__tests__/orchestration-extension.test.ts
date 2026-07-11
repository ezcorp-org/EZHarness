// Unit tests for the orchestration bundled extension's tool handler —
// Phase 4 commit 3. Scaffold + handler + `task:assignment_update`
// subscription shipped; the extension is not yet bundled / wired.
//
// Pattern mirrors src/__tests__/task-tracking-extension.test.ts — we
// import the extension's handler + subscription callback directly and
// inject fake SDK bindings via the `_setAgentConfigsForTests` /
// `_setSpawnForTests` / `_setDefaultTimeoutMsForTests` helpers. Because
// both terminal statuses (completed/failed) resolve the promise gate
// rather than reject, the only `reject` path is the timeout branch —
// keeps test wiring simple.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  tools,
  _setAgentConfigsForTests,
  _setSpawnForTests,
  _setDefaultTimeoutMsForTests,
  _setCancelRunForTests,
  _setQueueAgentMessageForTests,
  _resetBindingsForTests,
  _internals,
} from "../../docs/extensions/examples/orchestration/index";
import type {
  SpawnAssignmentInput,
  SpawnAssignmentHandle,
  CancelRunResult,
} from "@ezcorp/sdk/runtime";

// ── In-memory fakes ────────────────────────────────────────────────

class FakeAgentConfigs {
  private configs = new Map<
    string,
    { id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null }
  >();
  constructor(
    seed: Array<{ id: string; name: string; description?: string; isTeam?: boolean }> = [],
  ) {
    for (const c of seed) {
      this.configs.set(c.id, {
        id: c.id,
        name: c.name,
        description: c.description ?? "",
        isTeam: c.isTeam ?? false,
        ownerUserId: "user-test",
      });
    }
  }
  async list() {
    return Array.from(this.configs.values());
  }
  async resolve(idOrName: string) {
    const byId = this.configs.get(idOrName);
    if (byId) return byId;
    for (const c of this.configs.values()) {
      if (c.name.toLowerCase() === idOrName.trim().toLowerCase()) return c;
    }
    return null;
  }
}

type SpawnCall = { input: SpawnAssignmentInput };

function makeFakeSpawn(opts: {
  mode?: "happy" | "throw-dispatch";
  throwMessage?: string;
  assignmentIdPrefix?: string;
} = {}) {
  const calls: SpawnCall[] = [];
  const mode = opts.mode ?? "happy";
  let counter = 0;
  const fn = async (input: SpawnAssignmentInput): Promise<SpawnAssignmentHandle> => {
    calls.push({ input });
    if (mode === "throw-dispatch") {
      throw new Error(opts.throwMessage ?? "dispatch boom");
    }
    counter += 1;
    const prefix = opts.assignmentIdPrefix ?? "asn";
    const id = `${prefix}-${counter}`;
    return {
      subConversationId: `sub-${id}`,
      agentRunId: `run-${id}`,
      taskId: `task-${id}`,
      assignmentId: id,
    };
  };
  return { fn, calls };
}

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  const o = out as { isError?: boolean };
  return o.isError === true;
}

function expectAgentMeta(out: unknown): { subConversationId: string; agentName: string; agentConfigId: string } | undefined {
  const o = out as { details?: { _agentMeta?: unknown } };
  return o.details?._agentMeta as
    | { subConversationId: string; agentName: string; agentConfigId: string }
    | undefined;
}

let fakeAgents: FakeAgentConfigs;
// Records every agentRunId the give-up path reaps. Reset per test; a default
// safe fake is injected in beforeEach so timeout tests never fall through to
// the real SDK `cancelRun` (which would block on an absent host channel).
let cancelRunCalls: string[];
// Records every send_to_agent steering enqueue routed through the mocked
// queueAgentMessage SDK client. Reset per test.
let queueCalls: Array<{ subConversationId: string; message: string }>;

beforeEach(() => {
  fakeAgents = new FakeAgentConfigs([
    { id: "agent-builder", name: "builder", description: "Builds things" },
    { id: "agent-writer", name: "writer", description: "Writes things" },
  ]);
  _setAgentConfigsForTests(fakeAgents);
  // Default: identity-passthrough spawn. Tests that need specific
  // behavior override via _setSpawnForTests.
  _setDefaultTimeoutMsForTests(60_000);
  cancelRunCalls = [];
  _setCancelRunForTests(async (agentRunId: string): Promise<CancelRunResult> => {
    cancelRunCalls.push(agentRunId);
    return { cancelled: true };
  });
  // Default queue-agent-message stub — records calls, reports queued. Tests that
  // need a foreign/host-reject response override via _setQueueAgentMessageForTests.
  queueCalls = [];
  _setQueueAgentMessageForTests(async (subConversationId: string, message: string) => {
    queueCalls.push({ subConversationId, message });
    return { queued: true };
  });
  _internals.pendingInvocations.clear();
  _internals.backgroundSpawns.clear();
});

afterEach(() => {
  _resetBindingsForTests();
  _setDefaultTimeoutMsForTests(60_000);
  _internals.pendingInvocations.clear();
  _internals.backgroundSpawns.clear();
});

// ── invoke_agent — happy path ──────────────────────────────────────

describe("orchestration extension — invoke_agent happy path", () => {
  test("spawn + subscription fires 'completed' → tool-result text matches resultPreview, _agentMeta populated", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "Build a thing" });

    // Drive the subscription handler directly with a synthetic event.
    // Poll briefly because the handler awaits `spawn` before registering.
    let handle: SpawnAssignmentHandle | undefined;
    for (let i = 0; i < 20 && !handle; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (calls.length > 0) {
        // Need the assignmentId the spawn generated — grab from pending map.
        const keys = Array.from(_internals.pendingInvocations.keys());
        if (keys[0]) {
          handle = {
            subConversationId: `sub-${keys[0]}`,
            agentRunId: `run-${keys[0]}`,
            taskId: `task-${keys[0]}`,
            assignmentId: keys[0],
          };
        }
      }
    }
    expect(handle).toBeDefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: handle!.taskId,
      assignment: {
        id: handle!.assignmentId,
        status: "completed",
        resultPreview: "Built the thing successfully",
      },
    });

    const out = await invocation;
    expect(expectText(out)).toBe("Built the thing successfully");
    expect(expectIsError(out)).toBe(false);
    const meta = expectAgentMeta(out);
    expect(meta).toBeDefined();
    expect(meta!.agentName).toBe("builder");
    expect(meta!.agentConfigId).toBe("agent-builder");
    expect(meta!.subConversationId).toBe(handle!.subConversationId);
  });
});

// ── invoke_agent — full result (Wave 1) ────────────────────────────

describe("orchestration extension — invoke_agent full result", () => {
  test("prefers the top-level resultFull over the 200-char resultPreview", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "Research" });

    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (calls.length > 0) assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(assignmentId).toBeDefined();

    const preview = "A".repeat(200) + "...";
    const full = "A".repeat(4000); // longer than any preview
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: preview },
      resultFull: full,
    });

    const out = await invocation;
    // The orchestrator sees the FULL text, not the truncated preview.
    expect(expectText(out)).toBe(full);
    expect(expectText(out)).not.toBe(preview);
    expect(expectIsError(out)).toBe(false);
  });

  test("falls back to resultPreview when resultFull is absent (older host build)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "Legacy" });
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (calls.length > 0) assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(assignmentId).toBeDefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: "just the preview" },
      // no resultFull
    });

    const out = await invocation;
    expect(expectText(out)).toBe("just the preview");
  });
});

// ── invoke_agent — failed sub-run ──────────────────────────────────

describe("orchestration extension — invoke_agent failed sub-run", () => {
  test("subscription fires 'failed' → tool-result has isError: true, text = resultPreview", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "Fails" });
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(assignmentId).toBeDefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: {
        id: assignmentId!,
        status: "failed",
        resultPreview: "sub-agent exploded",
      },
    });

    const out = await invocation;
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toBe("sub-agent exploded");
    // _agentMeta should still be populated on failure.
    const meta = expectAgentMeta(out);
    expect(meta).toBeDefined();
    expect(meta!.agentConfigId).toBe("agent-builder");
  });
});

// ── invoke_agent — unknown agentConfigId ───────────────────────────

describe("orchestration extension — unknown agentConfigId", () => {
  test("resolve returns null → tool-result isError, error text contains the agent id", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const out = await tools.invoke_agent!({
      agentConfigId: "agent-does-not-exist",
      task: "nope",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("agent-does-not-exist");
    // Spawn MUST NOT have been called.
    expect(calls).toHaveLength(0);
  });
});

// ── invoke_agent — dispatch error ──────────────────────────────────

describe("orchestration extension — dispatch error", () => {
  test("spawn throws → tool-result isError, error text contains the throw message", async () => {
    const { fn } = makeFakeSpawn({ mode: "throw-dispatch", throwMessage: "network down" });
    _setSpawnForTests(fn);

    const out = await tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Build",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("network down");
    // No pending invocation was left behind.
    expect(_internals.pendingInvocations.size).toBe(0);
  });
});

// ── invoke_agent — timeout ─────────────────────────────────────────

describe("orchestration extension — timeout", () => {
  test("subscription never fires → tool-result isError with timeout text", async () => {
    _setDefaultTimeoutMsForTests(20);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const out = await tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Never completes",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
    expect(expectText(out)).toContain("builder");
    // Pending map is cleaned up.
    expect(_internals.pendingInvocations.size).toBe(0);
  });
});

// ── invoke_agent — self-delivery safety ────────────────────────────

describe("orchestration extension — foreign assignmentId", () => {
  test("handler with an assignmentId not in pendingInvocations → no-op (no throw, nothing leaks)", async () => {
    // Seed a pending invocation so the map is non-empty.
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "real" });
    let realId: string | undefined;
    for (let i = 0; i < 20 && !realId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      realId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(realId).toBeDefined();
    const sizeBefore = _internals.pendingInvocations.size;

    // Deliver an update for a completely unrelated assignment id (e.g.
    // from task-tracking). Must NOT throw. Must NOT resolve the real
    // invocation. Must NOT mutate our pending map.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: "stranger-assignment", status: "completed", resultPreview: "not ours" },
    });
    expect(_internals.pendingInvocations.size).toBe(sizeBefore);

    // Clean up: resolve the real invocation.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: realId!, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });
});

// ── invoke_agent — sliding (activity-aware) deadline ───────────────
//
// A non-terminal `task:assignment_update` for a tracked invocation is no
// longer a no-op: it RESETS the give-up timer (the host emits one on every
// auto-continue / autonomous cycle transition), so a long, legitimately-
// active multi-cycle child stays alive as long as it shows lifecycle
// activity. The pending entry is preserved (same object) and the invocation
// promise still does NOT resolve until a terminal status arrives.

describe("orchestration extension — sliding deadline", () => {
  test("a non-terminal update re-arms the timer (new handle, same pending entry); promise does not resolve", async () => {
    _setDefaultTimeoutMsForTests(100);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "go" });

    let assignmentId: string | undefined;
    for (let i = 0; i < 50 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(assignmentId).toBeDefined();

    const before = _internals.pendingInvocations.get(assignmentId!)!;
    const timerBefore = before.timeoutHandle;

    // Non-terminal status → timer RESET (clearTimeout + re-arm). Same
    // pending object, but a NEW timeout handle.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "running", resultPreview: "still working" },
    });

    const after = _internals.pendingInvocations.get(assignmentId!)!;
    expect(after).toBe(before);
    expect(after.timeoutHandle).not.toBe(timerBefore);
    expect(_internals.pendingInvocations.size).toBe(1);

    // Invocation promise did NOT resolve — race it against a microtask
    // sentinel and confirm the sentinel wins.
    const sentinel = Symbol("not-resolved");
    const raceResult = await Promise.race([
      Promise.resolve(invocation).then(() => "resolved" as const),
      Promise.resolve(sentinel),
    ]);
    expect(raceResult).toBe(sentinel);

    // Terminal resolves normally.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: "done at last" },
    });
    const out = await invocation;
    expect(expectText(out)).toBe("done at last");
    expect(expectIsError(out)).toBe(false);
    expect(_internals.pendingInvocations.size).toBe(0);
  });

  test("staggered non-terminal updates keep the invocation alive well past 2× the base timeout, then it completes normally", async () => {
    // Base 100ms. Each activity update lands ~60ms apart (< base, so the
    // timer never fires between updates) and total elapsed exceeds 2× base
    // (200ms) — proving the deadline slides on activity rather than the
    // flat base firing at 100ms. cancelRun must never be invoked here.
    _setDefaultTimeoutMsForTests(100);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "loopy" });
    const key = await drainPendingKey();

    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      // Still alive at each 60ms tick (< 100ms base).
      expect(_internals.pendingInvocations.size).toBe(1);
      await _internals.handleAssignmentUpdate({
        conversationId: "conv-x",
        taskId: `task-${key}`,
        assignment: { id: key, status: "running" },
      });
    }

    // ~240ms elapsed (> 2× the 100ms base) and the invocation survived
    // because every activity update reset the timer.
    expect(_internals.pendingInvocations.size).toBe(1);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "loop done" },
    });
    const out = await invocation;
    expect(expectText(out)).toBe("loop done");
    expect(expectIsError(out)).toBe(false);
    expect(cancelRunCalls).toHaveLength(0); // never reaped — it stayed active
  });
});

// ── invoke_agent — reuseSubConversationFor ─────────────────────────

describe("orchestration extension — spawn invocation shape", () => {
  test("spawn called with reuseSubConversationFor === agentConfigId", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "go" });
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.agentConfigId).toBe("agent-builder");
    expect(calls[0]!.input.reuseSubConversationFor).toBe("agent-builder");
    expect(calls[0]!.input.task).toBe("go");
    expect(calls[0]!.input.title).toBe("builder");

    // Drain.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: "ok" },
    });
    await invocation;
  });
});

// ── invoke_agent — invocationMetadata plumbing ─────────────────────

describe("orchestration extension — invocationMetadata forwarding", () => {
  async function run(metadata: Record<string, unknown> | undefined) {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const invocation = tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "go" },
      metadata ? { invocationMetadata: metadata } : undefined,
    );
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: "ok" },
    });
    await invocation;
    return calls[0]!.input;
  }

  test("parentMessageId forwarded when set", async () => {
    const input = await run({ parentMessageId: "msg-1" });
    expect(input.parentMessageId).toBe("msg-1");
  });

  test("overrides forwarded when set", async () => {
    const overrides = { model: "claude-opus", systemPromptAppend: "extra" };
    const input = await run({ overrides });
    expect(input.overrides).toEqual(overrides);
  });

  test("teamToolScope forwarded when set", async () => {
    const teamToolScope = { allowedTools: ["a", "b"], deniedTools: ["c"] };
    const input = await run({ teamToolScope });
    expect(input.teamToolScope).toEqual(teamToolScope);
  });

  test("orchestrationDepth forwarded when set", async () => {
    const input = await run({ orchestrationDepth: 2 });
    expect(input.orchestrationDepth).toBe(2);
  });

  test("parentRunId forwarded when set", async () => {
    const input = await run({ parentRunId: "orch-run-1" });
    expect(input.parentRunId).toBe("orch-run-1");
  });

  test("no metadata fields forwarded when invocationMetadata is absent", async () => {
    const input = await run(undefined);
    expect(input.parentMessageId).toBeUndefined();
    expect(input.overrides).toBeUndefined();
    expect(input.teamToolScope).toBeUndefined();
    expect(input.orchestrationDepth).toBeUndefined();
    expect(input.parentRunId).toBeUndefined();
    // Core fields still plumb through.
    expect(input.task).toBe("go");
    expect(input.agentConfigId).toBe("agent-builder");
    expect(input.reuseSubConversationFor).toBe("agent-builder");
  });
});

// ── Pending-map cleanup ────────────────────────────────────────────

describe("orchestration extension — pending-map lifecycle", () => {
  test("pendingInvocations is empty after completion", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "go" });
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(_internals.pendingInvocations.size).toBe(1);
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "completed", resultPreview: "ok" },
    });
    await invocation;
    expect(_internals.pendingInvocations.size).toBe(0);
  });

  test("pendingInvocations is empty after timeout", async () => {
    _setDefaultTimeoutMsForTests(20);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.invoke_agent!({ agentConfigId: "agent-builder", task: "slow" });
    expect(_internals.pendingInvocations.size).toBe(0);
  });
});

// ── Concurrent invocations ─────────────────────────────────────────

describe("orchestration extension — concurrent invocations", () => {
  test("two in-flight invocations each resolve from their own event (no cross-talk)", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const p1 = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "first" });
    const p2 = tools.invoke_agent!({ agentConfigId: "agent-writer", task: "second" });

    // Both should register pending entries.
    let ids: string[] = [];
    for (let i = 0; i < 40 && ids.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 1));
      ids = Array.from(_internals.pendingInvocations.keys());
    }
    expect(ids).toHaveLength(2);

    // Deliver distinct completions. Each pending entry tracks its agent
    // name; verify the text returned matches its own event, not the
    // sibling's.
    const entries = ids.map((id) => ({
      id,
      pending: _internals.pendingInvocations.get(id)!,
    }));
    const builderEntry = entries.find((e) => e.pending.agentConfigId === "agent-builder");
    const writerEntry = entries.find((e) => e.pending.agentConfigId === "agent-writer");
    expect(builderEntry).toBeDefined();
    expect(writerEntry).toBeDefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: builderEntry!.id, status: "completed", resultPreview: "first-done" },
    });
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: writerEntry!.id, status: "completed", resultPreview: "second-done" },
    });

    const out1 = await p1;
    const out2 = await p2;
    expect(expectText(out1)).toBe("first-done");
    expect(expectText(out2)).toBe("second-done");
    const meta1 = expectAgentMeta(out1);
    const meta2 = expectAgentMeta(out2);
    expect(meta1!.agentConfigId).toBe("agent-builder");
    expect(meta2!.agentConfigId).toBe("agent-writer");

    // Map fully drained.
    expect(_internals.pendingInvocations.size).toBe(0);
  });
});

// ── invoke_agent — autonomous self-continuation opt-in ─────────────
//
// The optional `autonomous` / `maxCycles` tool args map to
// `spawnInput.autonomousContinuation`, and presence of the opt-in
// widens the synchronous completion-wait far beyond the bounded 60s
// default so a looping sub-agent isn't spuriously timed out.

async function drainPendingKey(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 1));
    const keys = Array.from(_internals.pendingInvocations.keys());
    if (keys[0]) return keys[0];
  }
  throw new Error("spawn never registered a pending invocation");
}

describe("orchestration extension — autonomous opt-in", () => {
  test("autonomous + maxCycles → spawnInput.autonomousContinuation = { maxCycles }", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Open-ended work",
      autonomous: true,
      maxCycles: 4,
    });
    const key = await drainPendingKey();
    expect(calls[0]!.input.autonomousContinuation).toEqual({ maxCycles: 4 });

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("autonomous true without maxCycles → autonomousContinuation = {}", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Open-ended",
      autonomous: true,
    });
    const key = await drainPendingKey();
    expect(calls[0]!.input.autonomousContinuation).toEqual({});

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("no autonomous flag → spawnInput omits autonomousContinuation (legacy)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "One bounded turn",
    });
    const key = await drainPendingKey();
    expect(calls[0]!.input.autonomousContinuation).toBeUndefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("autonomous opt-in widens the wait: tiny default timeout does NOT reject the loop", async () => {
    // If the bounded default applied, this 20ms timeout would fire and
    // drop the pending invocation. Autonomous mode must bypass it.
    _setDefaultTimeoutMsForTests(20);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Long autonomous job",
      autonomous: true,
      maxCycles: 2,
    });
    const key = await drainPendingKey();

    // Wait well past the 20ms default timeout.
    await new Promise((r) => setTimeout(r, 60));
    // Still pending → the widened autonomous timeout is in effect.
    expect(_internals.pendingInvocations.size).toBe(1);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "loop done" },
    });
    const out = await invocation;
    expect(expectText(out)).toBe("loop done");
    expect(expectIsError(out)).toBe(false);
  });
});

// ── invoke_agent — configurable timeout resolution ─────────────────
//
// Base timeout precedence (highest first): a valid per-call
// `timeoutSeconds` (30..3600s) → host-threaded `md.invokeTimeoutMs` →
// module `defaultTimeoutMs`. Each branch is exercised by making the
// resolved timeout tiny (fires fast) or large (survives).

describe("orchestration extension — configurable timeout resolution", () => {
  test("md.invokeTimeoutMs is the base timeout (a tiny value fires fast, not the 60s default)", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    // Default is 60s (beforeEach); a 20ms md value means the timer fires
    // in ~20ms — proving md.invokeTimeoutMs, not the default, is the base.
    const out = await tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "x" },
      { invocationMetadata: { invokeTimeoutMs: 20 } },
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
    expect(cancelRunCalls).toHaveLength(1); // reaped on give-up
  });

  test("a valid per-call timeoutSeconds overrides md.invokeTimeoutMs", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    // md base is a tiny 20ms; the 30s per-call override must win so the
    // invocation survives well past 20ms.
    const invocation = tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "x", timeoutSeconds: 30 },
      { invocationMetadata: { invokeTimeoutMs: 20 } },
    );
    const key = await drainPendingKey();
    await new Promise((r) => setTimeout(r, 60)); // past the 20ms md base
    expect(_internals.pendingInvocations.size).toBe(1); // 30s override in effect
    expect(cancelRunCalls).toHaveLength(0);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "ok" },
    });
    const out = await invocation;
    expect(expectIsError(out)).toBe(false);
  });

  test("an out-of-range timeoutSeconds (< 30) falls back to md.invokeTimeoutMs", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "x", timeoutSeconds: 5 },
      { invocationMetadata: { invokeTimeoutMs: 20 } },
    );
    // 5s is below the 30s floor → ignored → md base (20ms) applies → fires.
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
  });

  test("an out-of-range timeoutSeconds (> 3600) falls back to md.invokeTimeoutMs", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "x", timeoutSeconds: 99_999 },
      { invocationMetadata: { invokeTimeoutMs: 20 } },
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
  });

  test("an invalid md.invokeTimeoutMs falls back to defaultTimeoutMs", async () => {
    _setDefaultTimeoutMsForTests(20);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.invoke_agent!(
      { agentConfigId: "agent-builder", task: "x" },
      { invocationMetadata: { invokeTimeoutMs: -1 } }, // non-positive → invalid
    );
    // Falls back to the 20ms default → fires fast.
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
  });
});

// ── invoke_agent — reap child on give-up ───────────────────────────
//
// On timeout the handler cancels the still-running child (best-effort,
// awaited) BEFORE rejecting, so the child stops burning tokens and its
// quota slot frees before the orchestrator can re-dispatch. A cancel
// failure must NOT mask the timeout — it is folded into the error text.

describe("orchestration extension — reap child on give-up", () => {
  test("timeout cancels the child via cancelRun(handle.agentRunId) and reports it", async () => {
    _setDefaultTimeoutMsForTests(20);
    const { fn } = makeFakeSpawn(); // handle.agentRunId === "run-asn-1"
    _setSpawnForTests(fn);

    const out = await tools.invoke_agent!({ agentConfigId: "agent-builder", task: "x" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
    // Reaped with the spawn handle's agentRunId.
    expect(cancelRunCalls).toEqual(["run-asn-1"]);
    expect(expectText(out)).toContain("the child run was cancelled");
    // Pending map cleaned up.
    expect(_internals.pendingInvocations.size).toBe(0);
  });

  test("a throwing cancelRun still rejects with the timeout error and notes the failure", async () => {
    _setDefaultTimeoutMsForTests(20);
    _setSpawnForTests(makeFakeSpawn().fn);
    _setCancelRunForTests(async () => {
      throw new Error("rpc down");
    });

    const out = await tools.invoke_agent!({ agentConfigId: "agent-builder", task: "x" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
    expect(expectText(out)).toContain("could not be cancelled");
    expect(expectText(out)).toContain("rpc down");
    expect(_internals.pendingInvocations.size).toBe(0);
  });

  test("cancelRun resolving { cancelled: false } notes the reason in the error", async () => {
    _setDefaultTimeoutMsForTests(20);
    _setSpawnForTests(makeFakeSpawn().fn);
    _setCancelRunForTests(async (): Promise<CancelRunResult> => ({
      cancelled: false,
      reason: "missing-run",
    }));

    const out = await tools.invoke_agent!({ agentConfigId: "agent-builder", task: "x" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("could not be cancelled");
    expect(expectText(out)).toContain("missing-run");
  });

  test("timeout error text carries agent name, seconds, and subConversationId; _agentMeta preserved", async () => {
    _setDefaultTimeoutMsForTests(600); // Math.round(0.6) === 1 → "1s"
    const { fn } = makeFakeSpawn({ assignmentIdPrefix: "z" }); // subConversationId === "sub-z-1"
    _setSpawnForTests(fn);

    const out = await tools.invoke_agent!({ agentConfigId: "agent-builder", task: "x" });
    const text = expectText(out);
    expect(text).toContain("builder"); // agent name
    expect(text).toMatch(/timed out after 1s/); // effective timeout in seconds
    expect(text).toContain("sub-z-1"); // subConversationId to open the sub-conversation
    // _agentMeta is still attached to the error tool-result.
    const meta = expectAgentMeta(out);
    expect(meta).toBeDefined();
    expect(meta!.agentName).toBe("builder");
    expect(meta!.subConversationId).toBe("sub-z-1");
  });
});

// ── invoke_agent — reap follows the live cycle run ─────────────────
//
// A multi-cycle child mints a NEW run id per cycle; the spawn handle's
// `agentRunId` is frozen at cycle 1. The host stamps the live run id onto
// every non-terminal (cycle-boundary) assignment_update, and the ext must
// re-target its reap to that id — else a timeout would cancel the stale
// cycle-1 run, which the host no longer owns (cancel-run rejects it) while
// the live child keeps running. This is the CRITICAL regression the
// single-run reap tests missed.

describe("orchestration extension — reap follows the live cycle run", () => {
  test("a non-terminal update carrying a new agentRunId re-targets the reap to the live run", async () => {
    _setDefaultTimeoutMsForTests(100);
    const { fn } = makeFakeSpawn(); // handle.agentRunId === "run-asn-1"
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "loop" });
    const key = await drainPendingKey();
    // Reap target starts as the spawn handle's cycle-1 run id.
    expect(_internals.pendingInvocations.get(key)!.agentRunId).toBe("run-asn-1");

    // Cycle boundary: non-terminal update carrying the NEW live run id. This
    // resets the sliding-deadline timer AND re-targets the reap.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "running", agentRunId: "run-cycle-2" },
    });
    expect(_internals.pendingInvocations.get(key)!.agentRunId).toBe("run-cycle-2");

    // Let the (reset) timer fire → the reap must cancel the LIVE cycle run.
    await new Promise((r) => setTimeout(r, 160));
    const out = await invocation;
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/timed out/i);
    expect(cancelRunCalls).toEqual(["run-cycle-2"]); // NOT the stale "run-asn-1"
  });

  test("a non-terminal update WITHOUT an agentRunId leaves the reap target unchanged", async () => {
    _setDefaultTimeoutMsForTests(100);
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "loop" });
    const key = await drainPendingKey();

    // Cycle update that omits agentRunId (older host build) — the reap target
    // must stay the spawn handle's id, not become undefined.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "running" },
    });
    expect(_internals.pendingInvocations.get(key)!.agentRunId).toBe("run-asn-1");

    await new Promise((r) => setTimeout(r, 160));
    const out = await invocation;
    expect(expectIsError(out)).toBe(true);
    expect(cancelRunCalls).toEqual(["run-asn-1"]);
  });
});

// ── invoke_agent — structured output (Phase B1) ────────────────────
//
// When the invocation carried an `outputSchema`, the terminal
// assignment_update carries a `structuredResult` (host-validated parsed
// object → pretty JSON, success) or a `structuredResultError` (schema
// failure → isError with the violation summary + the raw output).

describe("orchestration extension — structured output", () => {
  const SCHEMA = {
    type: "object",
    properties: { grade: { type: "integer" }, notes: { type: "string" } },
    required: ["grade"],
  };

  test("outputSchema tool arg is threaded into spawnInput.outputSchema", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "grade this",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();
    expect(calls[0]!.input.outputSchema).toEqual(SCHEMA);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("a non-object outputSchema arg is dropped (not forwarded)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "go",
      // Array is not a valid schema object — the ext must not forward it.
      outputSchema: [{ type: "string" }] as unknown as Record<string, unknown>,
    });
    const key = await drainPendingKey();
    expect(calls[0]!.input.outputSchema).toBeUndefined();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("structuredResult → tool result text is pretty-printed JSON; success; _agentMeta preserved", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "grade",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();

    const parsed = { grade: 9, notes: "sharp corners" };
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "some raw preview" },
      resultFull: '{"grade":9,"notes":"sharp corners"}',
      structuredResult: parsed,
    });

    const out = await invocation;
    expect(expectText(out)).toBe(JSON.stringify(parsed, null, 2));
    expect(expectIsError(out)).toBe(false);
    const meta = expectAgentMeta(out);
    expect(meta).toBeDefined();
    expect(meta!.agentConfigId).toBe("agent-builder");
  });

  test("structuredResultError → isError with the violation summary AND the raw output", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "grade",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "raw-preview" },
      resultFull: "I could not produce valid JSON for you.",
      structuredResultError: "grade: required property is missing",
    });

    const out = await invocation;
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    expect(text).toContain("did not satisfy the schema");
    expect(text).toContain("grade: required property is missing");
    // The raw output rides along so the orchestrator can salvage.
    expect(text).toContain("I could not produce valid JSON for you.");
  });

  test("structuredResultOverCap → framed as an oversized SUCCESS (raw text), not a schema violation", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "grade",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "big..." },
      resultFull: '{"grade":9,"notes":"' + "z".repeat(100) + '"}',
      structuredResultError:
        "result validated against the schema but exceeds the 30KB structured cap; the (capped) raw output carries the result",
      structuredResultOverCap: true,
    });

    const out = await invocation;
    // Validated output that merely blew the size cap is NOT an error.
    expect(expectIsError(out)).toBe(false);
    const text = expectText(out);
    expect(text).toContain("validated against the schema but exceeded the 30KB structured cap");
    expect(text).not.toContain("did not satisfy the schema");
    expect(text).toContain('"grade":9');
  });

  test("structuredResult wins over structuredResultError when both are present", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "grade",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "raw" },
      structuredResult: { grade: 10 },
      structuredResultError: "should be ignored",
    });

    const out = await invocation;
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe(JSON.stringify({ grade: 10 }, null, 2));
  });

  test("oversized pretty form → returns COMPACT JSON (no whitespace inflation past the cap)", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "big",
      outputSchema: SCHEMA,
    });
    const key = await drainPendingKey();

    // Compact ≤ 30KB but pretty (2-space indent) > 30KB — the host attached
    // it because compact fits; the ext must NOT inflate it past the cap.
    const big = { items: Array.from({ length: 6000 }, () => "x") };
    const compact = JSON.stringify(big);
    const pretty = JSON.stringify(big, null, 2);
    expect(compact.length).toBeLessThanOrEqual(30_000);
    expect(pretty.length).toBeGreaterThan(30_000);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "raw" },
      structuredResult: big,
    });

    const out = await invocation;
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe(compact); // compact form, not pretty
    expect(expectText(out).length).toBeLessThanOrEqual(30_000);
  });
});

// ── invoke_agent — background spawn (Phase B2) ─────────────────────
//
// `background: true` dispatches the child and returns IMMEDIATELY with a
// handle payload. NO pending-invocation timer is armed (no timeout, no
// reap); the child is tracked in the process-local `backgroundSpawns` map
// for a later `collect_agent_result`, and the host notifies the parent.

function expectAgentMetaBg(out: unknown): {
  subConversationId: string;
  agentName: string;
  agentConfigId: string;
  assignmentId: string;
} {
  const meta = expectAgentMeta(out) as {
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    assignmentId: string;
  } | undefined;
  if (!meta) throw new Error("tool-result has no _agentMeta");
  return meta;
}

describe("orchestration extension — background spawn", () => {
  test("returns immediately with a handle payload; no pending timer; backgroundSpawns tracked", async () => {
    // A tiny default timeout would fire fast for a SYNC invoke — a background
    // spawn must NOT arm it at all.
    _setDefaultTimeoutMsForTests(20);
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    // Resolves without any subscription being driven — proves non-blocking.
    const out = await tools.invoke_agent!({
      agentConfigId: "agent-builder",
      task: "Long background job",
      background: true,
    });

    // Handle payload text + _agentMeta carry the assignmentId.
    const text = expectText(out);
    expect(expectIsError(out)).toBe(false);
    expect(text).toContain("started in the background");
    expect(text).toContain("collect_agent_result");
    // F4 (honest notify): the text must NOT falsely promise in-conversation
    // notification — a top-level orchestrator is never auto-notified, so it must
    // poll. The UI (task panel) is where completion actually shows.
    expect(text.toLowerCase()).not.toContain("you will be notified when it finishes");
    expect(text.toLowerCase()).toContain("do not assume you will be auto-notified");
    expect(text).toContain("task panel");
    const meta = expectAgentMetaBg(out);
    expect(meta.agentName).toBe("builder");
    expect(meta.agentConfigId).toBe("agent-builder");
    expect(meta.assignmentId).toBe("asn-1");
    expect(text).toContain(meta.assignmentId);
    expect(text).toContain(meta.subConversationId);

    // NO pending invocation registered (no timeout, no reap).
    expect(_internals.pendingInvocations.size).toBe(0);
    // Tracked as a background spawn instead.
    expect(_internals.backgroundSpawns.size).toBe(1);
    const bg = _internals.backgroundSpawns.get("asn-1")!;
    expect(bg.terminal).toBe(false);
    expect(bg.subConversationId).toBe("sub-asn-1");
    expect(bg.agentRunId).toBe("run-asn-1");

    // The spawn asked the host to notify the parent on terminal AND marked the
    // child detached so a post-parent-terminal cycle streams unparented rather
    // than self-failing.
    expect(calls[0]!.input.notifyParentOnTerminal).toBe(true);
    expect(calls[0]!.input.detached).toBe(true);

    // Wait well past the tiny default timeout — nothing fires (no timer),
    // nothing is reaped, and the entry stays put for a later collect.
    await new Promise((r) => setTimeout(r, 60));
    expect(_internals.pendingInvocations.size).toBe(0);
    expect(cancelRunCalls).toHaveLength(0);
    expect(_internals.backgroundSpawns.size).toBe(1);
  });

  test("a synchronous (non-background) invoke does NOT set notifyParentOnTerminal and does not touch backgroundSpawns", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "sync" });
    const key = await drainPendingKey();
    expect(calls[0]!.input.notifyParentOnTerminal).toBeUndefined();
    expect(calls[0]!.input.detached).toBeUndefined();
    expect(_internals.backgroundSpawns.size).toBe(0);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: `task-${key}`,
      assignment: { id: key, status: "completed", resultPreview: "done" },
    });
    await invocation;
  });

  test("unknown agentConfigId with background:true still errors before spawning", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.invoke_agent!({
      agentConfigId: "agent-does-not-exist",
      task: "nope",
      background: true,
    });
    expect(expectIsError(out)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(_internals.backgroundSpawns.size).toBe(0);
  });
});

// ── collect_agent_result (Phase B2) ────────────────────────────────

/** Dispatch a background invoke and return its assignmentId. */
// F3: the conversation that owns a background spawn. invoke_agent records it
// (from the host-set invocationMetadata.conversationId), and collect must be
// called from the SAME conversation to be authorized.
const OWNER_CONV = "conv-owner";

async function startBackground(
  args: Record<string, unknown> = {},
  conversationId: string = OWNER_CONV,
  spawnMeta: Record<string, unknown> = {},
): Promise<string> {
  const out = await tools.invoke_agent!(
    { agentConfigId: "agent-builder", task: "bg", background: true, ...args },
    { invocationMetadata: { conversationId, ...spawnMeta } },
  );
  return expectAgentMetaBg(out).assignmentId;
}

/** Collect as the owning conversation (or an override for cross-tenant tests).
 *  Pass `null` for `conversationId` to omit the ctx entirely (missing-metadata
 *  fail-closed case) — an explicit `undefined` would trigger the default. */
function collect(
  assignmentId: string,
  waitSeconds?: number,
  conversationId: string | null = OWNER_CONV,
) {
  return tools.collect_agent_result!(
    { assignmentId, ...(waitSeconds !== undefined ? { waitSeconds } : {}) },
    conversationId === null
      ? undefined
      : { invocationMetadata: { conversationId } },
  );
}

// ── send_to_agent (Phase B3) ───────────────────────────────────────

function send(
  args: Record<string, unknown>,
  conversationId: string | null = OWNER_CONV,
  extraMeta: Record<string, unknown> = {},
) {
  return tools.send_to_agent!(
    args,
    conversationId === null
      ? undefined
      : { invocationMetadata: { conversationId, ...extraMeta } },
  );
}

/** Drive a background spawn to a terminal state via the subscription handler. */
async function driveTerminal(assignmentId: string, resultFull = "done"): Promise<void> {
  await _internals.handleAssignmentUpdate({
    conversationId: "conv-x",
    taskId: `task-${assignmentId}`,
    assignment: { id: assignmentId, status: "completed", resultPreview: resultFull },
    resultFull,
  });
}

describe("send_to_agent", () => {
  test("neither assignmentId nor agentConfigId → error, exactly-one required", async () => {
    const out = await send({ message: "hi" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("EXACTLY ONE");
  });

  test("both assignmentId and agentConfigId → error", async () => {
    const out = await send({ assignmentId: "a", agentConfigId: "b", message: "hi" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("EXACTLY ONE");
  });

  test("empty message → error", async () => {
    const out = await send({ assignmentId: "a", message: "  " });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out).toLowerCase()).toContain("non-empty 'message'");
  });

  test("message over 8000 chars → error", async () => {
    const out = await send({ assignmentId: "a", message: "x".repeat(8001) });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("too long");
  });

  test("running background child → message queued for steering (via mocked RPC)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground(); // owned by OWNER_CONV, not terminal

    const out = await send({ assignmentId: id, message: "also check the logs" });
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toContain("queued for");
    expect(expectText(out)).toContain("will be delivered when its current cycle completes");
    // The mocked RPC was called with the child's sub-conversation + message.
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]!.subConversationId).toBe("sub-asn-1");
    expect(queueCalls[0]!.message).toBe("also check the logs");
  });

  test("terminal background child → new run redispatched on the reused sub-conversation", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const id = await startBackground(); // asn-1
    await driveTerminal(id);
    expect(_internals.backgroundSpawns.get(id)!.terminal).toBe(true);

    const out = await send({ assignmentId: id, message: "keep going" });
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toContain("continuing on its existing sub-conversation");
    // A second spawn was issued, reusing the sub-conversation for the agent.
    const continueCall = calls[calls.length - 1]!.input;
    expect(continueCall.task).toBe("keep going");
    expect(continueCall.reuseSubConversationFor).toBe("agent-builder");
    expect(continueCall.notifyParentOnTerminal).toBe(true);
    // Continuation runs background-style → detached so a cycle past the
    // parent's terminal streams unparented rather than self-failing.
    expect(continueCall.detached).toBe(true);
    // The new background spawn is tracked (asn-2), owned by the caller.
    const meta = expectAgentMetaBg(out);
    expect(meta.assignmentId).toBe("asn-2");
    expect(_internals.backgroundSpawns.get("asn-2")!.ownerConversationId).toBe(OWNER_CONV);
  });

  test("cross-conversation target → fail-closed not-found (no steer, no spawn)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground(); // owned by OWNER_CONV

    const out = await send({ assignmentId: id, message: "hi" }, "conv-intruder");
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no sub-agent is tracked");
    expect(queueCalls).toHaveLength(0);
  });

  test("missing caller conversation id → fail-closed not-found", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();
    const out = await send({ assignmentId: id, message: "hi" }, null);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no sub-agent is tracked");
  });

  test("agentConfigId target (terminal) → continues the reused sub-conversation", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const id = await startBackground(); // agentConfigId agent-builder
    await driveTerminal(id);

    const out = await send({ agentConfigId: "agent-builder", message: "round two" });
    expect(expectIsError(out)).toBe(false);
    const continueCall = calls[calls.length - 1]!.input;
    expect(continueCall.reuseSubConversationFor).toBe("agent-builder");
    expect(continueCall.task).toBe("round two");
  });

  test("host rejects steer as not-found (foreign sub-conv) → surfaced as not-found", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    _setQueueAgentMessageForTests(async () => ({ queued: false, reason: "not-found" }));
    const id = await startBackground(); // still running

    const out = await send({ assignmentId: id, message: "hi" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no sub-agent is tracked");
  });

  test("host reports not-running (child went idle) → falls through to a fresh continuation run", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    // The child is still in our RUNNING map, but the host says its run ended.
    _setQueueAgentMessageForTests(async () => ({ queued: false, reason: "not-running" }));
    const id = await startBackground(); // asn-1, tracked as running

    const out = await send({ assignmentId: id, message: "carry on" });
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toContain("continuing on its existing sub-conversation");
    // A continuation spawn was issued on the reused sub-conversation.
    const continueCall = calls[calls.length - 1]!.input;
    expect(continueCall.task).toBe("carry on");
    expect(continueCall.reuseSubConversationFor).toBe("agent-builder");
    expect(_internals.backgroundSpawns.get("asn-2")).toBeDefined();
  });

  test("EXPLOIT: restricted spawn continued on a NO-SCOPE follow-up reuses the RECORDED restrictions (not the empty current-turn metadata)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    // Turn 1: spawn the member WITH restrictions (as the @team wiring would).
    const teamToolScope = { allowedTools: ["read"], deniedTools: ["bash"] };
    const overrides = { toolRestriction: "read-only" };
    const id = await startBackground({}, OWNER_CONV, {
      teamToolScope,
      overrides,
      orchestrationDepth: 3,
    });
    await driveTerminal(id);

    // Turn 2: a plain top-level follow-up — send_to_agent's invocationMetadata
    // carries NO teamToolScope/overrides (only the host-set conversationId +
    // run-linkage). The continuation MUST still be restricted.
    const out = await send(
      { assignmentId: id, message: "also summarize" },
      OWNER_CONV,
      { parentRunId: "orch-run-turn2" }, // run-linkage only; no scope
    );
    expect(expectIsError(out)).toBe(false);
    const continueCall = calls[calls.length - 1]!.input;
    // Restrictions come from the RECORDED spawn, not the (empty) current turn.
    expect(continueCall.teamToolScope).toEqual(teamToolScope);
    expect(continueCall.overrides).toEqual(overrides);
    expect(continueCall.orchestrationDepth).toBe(3);
    // Run-linkage DOES come from the current turn (cascade-cancel anchor).
    expect(continueCall.parentRunId).toBe("orch-run-turn2");
    // The continuation re-records the same scope for a continuation-of-continuation.
    expect(_internals.backgroundSpawns.get("asn-2")!.spawnScope).toEqual({
      teamToolScope,
      overrides,
      orchestrationDepth: 3,
    });
  });

  test("agentConfigId continuation of a prior SYNC invoke reuses THAT entry's recorded scope", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    // The host reports the tracked child idle so the running-map target falls
    // through to a continuation (exercises the pending-invocation scope reuse).
    _setQueueAgentMessageForTests(async () => ({ queued: false, reason: "not-running" }));
    // Synthesize a still-pending SYNC invocation that recorded a scope.
    const teamToolScope = { allowedTools: ["read"] };
    _internals.pendingInvocations.set("sync-1", {
      resolve: () => {},
      reject: () => {},
      timeoutHandle: setTimeout(() => {}, 100_000),
      timeoutMs: 100_000,
      fireTimeout: () => {},
      agentName: "builder",
      agentConfigId: "agent-builder",
      subConversationId: "sub-sync-1",
      agentRunId: "run-sync-1",
      ownerConversationId: OWNER_CONV,
      spawnScope: { teamToolScope, overrides: { toolRestriction: "read-only" } },
    } as unknown as Parameters<typeof _internals.pendingInvocations.set>[1]);

    const out = await send({ agentConfigId: "agent-builder", message: "continue" });
    expect(expectIsError(out)).toBe(false);
    const continueCall = calls[calls.length - 1]!.input;
    expect(continueCall.teamToolScope).toEqual(teamToolScope);
    expect(continueCall.overrides).toEqual({ toolRestriction: "read-only" });
    // cleanup the synthetic pending timer
    clearTimeout(_internals.pendingInvocations.get("sync-1")?.timeoutHandle);
    _internals.pendingInvocations.delete("sync-1");
  });

  test("a target spawned WITHOUT restrictions continues without scope (faithful)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const id = await startBackground(); // no spawnMeta → no recorded scope
    await driveTerminal(id);

    const out = await send({ assignmentId: id, message: "go" });
    expect(expectIsError(out)).toBe(false);
    const continueCall = calls[calls.length - 1]!.input;
    expect(continueCall).not.toHaveProperty("teamToolScope");
    expect(continueCall).not.toHaveProperty("overrides");
    expect(continueCall).not.toHaveProperty("orchestrationDepth");
    expect(_internals.backgroundSpawns.get("asn-2")!.spawnScope).toBeUndefined();
  });

  test("steer path: queueAgentMessage throws → surfaced as a queue-failure error (not not-found)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    _setQueueAgentMessageForTests(async () => {
      throw new Error("channel down");
    });
    const id = await startBackground(); // still running

    const out = await send({ assignmentId: id, message: "hi" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("Failed to queue message");
    expect(expectText(out)).toContain("channel down");
  });

  test("continuation of a terminal child whose agent config no longer resolves → Unknown agent error", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    // Synthesize a terminal background entry for an agent that FakeAgentConfigs
    // does not know (deleted since spawn).
    _internals.backgroundSpawns.set("bg-gone", {
      agentName: "ghost",
      agentConfigId: "agent-gone",
      subConversationId: "sub-gone",
      agentRunId: "run-gone",
      ownerConversationId: OWNER_CONV,
      terminal: true,
      collected: false,
      waiters: new Set(),
      result: { result: "done", success: true },
    } as unknown as Parameters<typeof _internals.backgroundSpawns.set>[1]);

    const out = await send({ assignmentId: "bg-gone", message: "again" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain(`Unknown agent "agent-gone"`);
  });

  test("continuation spawn failure → 'failed to continue' error", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const id = await startBackground(); // asn-1
    await driveTerminal(id);
    // Now make the continuation spawn throw.
    _setSpawnForTests(makeFakeSpawn({ mode: "throw-dispatch", throwMessage: "spawn boom" }).fn);

    const out = await send({ assignmentId: id, message: "keep going" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("failed to continue");
    expect(expectText(out)).toContain("spawn boom");
  });

  test("steer a still-pending SYNC invocation BY assignmentId → queued (resolveSendTarget pending-by-id branch)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    // A blocking sync invoke_agent leaves a PendingInvocation keyed by its
    // assignmentId; steering it by that id resolves the pending-by-id branch
    // (distinct from the agentConfigId-loop branch).
    _internals.pendingInvocations.set("sync-steer", {
      resolve: () => {},
      reject: () => {},
      timeoutHandle: setTimeout(() => {}, 100_000),
      timeoutMs: 100_000,
      fireTimeout: () => {},
      agentName: "builder",
      agentConfigId: "agent-builder",
      subConversationId: "sub-sync-steer",
      agentRunId: "run-sync-steer",
      ownerConversationId: OWNER_CONV,
      spawnScope: { teamToolScope: { allowedTools: ["read"] } },
    } as unknown as Parameters<typeof _internals.pendingInvocations.set>[1]);

    const out = await send({ assignmentId: "sync-steer", message: "narrow the search" });
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toContain("queued for");
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]!.subConversationId).toBe("sub-sync-steer");

    clearTimeout(_internals.pendingInvocations.get("sync-steer")?.timeoutHandle);
    _internals.pendingInvocations.delete("sync-steer");
  });
});

describe("collect_agent_result", () => {
  test("terminal already reached → returns the full result immediately (resultFull-preferred), success", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    const full = "Z".repeat(4000);
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "clip..." },
      resultFull: full,
    });

    const out = await collect(id);
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe(full);
    const meta = expectAgentMetaBg(out);
    expect(meta.assignmentId).toBe(id);
    expect(meta.subConversationId).toBe("sub-asn-1");
  });

  test("terminal structured result → collect returns pretty-printed JSON", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    const parsed = { grade: 9, notes: "ok" };
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "raw" },
      resultFull: '{"grade":9}',
      structuredResult: parsed,
    });

    const out = await collect(id);
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe(JSON.stringify(parsed, null, 2));
  });

  test("terminal failure → collect returns isError with the result text", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "failed", resultPreview: "boom" },
      resultFull: "the agent failed: boom",
    });

    const out = await collect(id);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toBe("the agent failed: boom");
  });

  test("still running, waitSeconds omitted → non-error 'still running' status immediately", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    const out = await collect(id);
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toMatch(/still running/i);
    expect(expectText(out)).toContain(id);
  });

  test("still running, waitSeconds>0 → resolves when a terminal update arrives", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    // Kick off a waiting collect (does NOT resolve yet).
    const collectPromise = collect(id, 30);

    // A gate registered on the background entry.
    let waiters = 0;
    for (let i = 0; i < 50 && waiters === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
      waiters = _internals.backgroundSpawns.get(id)!.waiters.size;
    }
    expect(waiters).toBe(1);

    // Deliver the terminal update — the gate resolves with the result.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "p" },
      resultFull: "waited-and-done",
    });

    const out = await collectPromise;
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe("waited-and-done");
    // Waiter cleaned up; entry retained (memoized result).
    expect(_internals.backgroundSpawns.get(id)!.waiters.size).toBe(0);
    expect(_internals.backgroundSpawns.get(id)!.terminal).toBe(true);
  });

  test("still running, waitSeconds expires with no terminal → non-error 'still running' (child NOT reaped)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    // waitSeconds:1 → ~1s idle window; no terminal arrives → expiry.
    const out = await collect(id, 1);
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toMatch(/still running/i);
    // A collect timeout must NOT cancel the child.
    expect(cancelRunCalls).toHaveLength(0);
    // Gate cleaned up; entry still tracked (not terminal).
    expect(_internals.backgroundSpawns.get(id)!.waiters.size).toBe(0);
    expect(_internals.backgroundSpawns.get(id)!.terminal).toBe(false);
  });

  test("sliding deadline: activity updates keep a waiting collect alive past its base wait, then it resolves", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();

    // waitSeconds:1 base. Deliver a non-terminal activity update at ~0.6s
    // (< 1s base, so the timer never fired) which RESETS the deadline; total
    // elapsed then exceeds 1s, proving the slide. Finally a terminal resolves.
    const collectPromise = collect(id, 1);
    for (let i = 0; i < 50 && _internals.backgroundSpawns.get(id)!.waiters.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 600));
    // Activity → slide (also updates the live run id).
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "running", agentRunId: "run-cycle-2" },
    });
    expect(_internals.backgroundSpawns.get(id)!.agentRunId).toBe("run-cycle-2");
    await new Promise((r) => setTimeout(r, 600)); // ~1.2s total > 1s base
    // Still waiting (would have expired at 1s without the slide).
    expect(_internals.backgroundSpawns.get(id)!.waiters.size).toBe(1);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "p" },
      resultFull: "slid-then-done",
    });
    const out = await collectPromise;
    expect(expectText(out)).toBe("slid-then-done");
  });

  test("unknown assignmentId → clear error", async () => {
    const out = await collect("not-a-real-id");
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no background agent");
    expect(expectText(out)).toContain("not-a-real-id");
  });

  test("empty / missing assignmentId → clear error", async () => {
    const out = await collect("  ");
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/non-empty 'assignmentId'/);
  });

  // ── F3: caller authorization (process-global map) ────────────────
  test("cross-conversation collect → not-found (does not leak another conversation's result)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground({}, "conv-A");
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "secret" },
      resultFull: "conv-A's private result",
    });

    // A DIFFERENT conversation asks for the same assignmentId → not-found,
    // and the real (terminal) result never leaks.
    const out = await collect(id, undefined, "conv-B");
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no background agent");
    expect(expectText(out)).not.toContain("conv-A's private result");

    // The owning conversation still collects it fine.
    const owned = await collect(id, undefined, "conv-A");
    expect(expectIsError(owned)).toBe(false);
    expect(expectText(owned)).toBe("conv-A's private result");
  });

  test("missing caller conversation id → not-found (fail closed)", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const id = await startBackground();
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id, status: "completed", resultPreview: "p" },
      resultFull: "done",
    });
    // No invocationMetadata.conversationId on the collect → not-found.
    const out = await collect(id, undefined, null);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("no background agent");
  });

  test("clampWaitSeconds bounds waitSeconds into [0, MAX] and floors fractions", () => {
    const { clampWaitSeconds, MAX_COLLECT_WAIT_SECONDS } = _internals;
    // Non-numbers / non-finite → 0.
    expect(clampWaitSeconds(undefined)).toBe(0);
    expect(clampWaitSeconds("30" as unknown)).toBe(0);
    expect(clampWaitSeconds(Number.NaN)).toBe(0);
    expect(clampWaitSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    // At/below the floor → 0.
    expect(clampWaitSeconds(0)).toBe(0);
    expect(clampWaitSeconds(-5)).toBe(0);
    // At/above the ceiling → clamped to MAX (proves the cap without a real wait).
    expect(clampWaitSeconds(MAX_COLLECT_WAIT_SECONDS)).toBe(MAX_COLLECT_WAIT_SECONDS);
    expect(clampWaitSeconds(9_999)).toBe(MAX_COLLECT_WAIT_SECONDS);
    // In range → floored to an integer.
    expect(clampWaitSeconds(45.9)).toBe(45);
  });
});

// ── background map bounding / eviction ─────────────────────────────

describe("orchestration extension — backgroundSpawns bounding", () => {
  test("keeps at most MAX_BACKGROUND_SPAWNS, evicting the oldest TERMINAL entry first", async () => {
    const MAX = _internals.MAX_BACKGROUND_SPAWNS;
    // Fill to capacity, marking each terminal so it is eviction-eligible.
    for (let i = 0; i < MAX; i++) {
      const asn = `bg-${i}`;
      _internals.registerBackgroundSpawn(
        { assignmentId: asn, subConversationId: `sub-${asn}`, agentRunId: `run-${asn}`, taskId: `task-${asn}` },
        "builder",
        "agent-builder",
      );
      await _internals.handleAssignmentUpdate({
        conversationId: "conv-x",
        taskId: `task-${asn}`,
        assignment: { id: asn, status: "completed", resultPreview: "done" },
      });
    }
    expect(_internals.backgroundSpawns.size).toBe(MAX);
    expect(_internals.backgroundSpawns.has("bg-0")).toBe(true);

    // One more → oldest terminal (bg-0) evicted; size holds at MAX.
    _internals.registerBackgroundSpawn(
      { assignmentId: "bg-new", subConversationId: "sub-new", agentRunId: "run-new", taskId: "task-new" },
      "builder",
      "agent-builder",
    );
    expect(_internals.backgroundSpawns.size).toBe(MAX);
    expect(_internals.backgroundSpawns.has("bg-0")).toBe(false);
    expect(_internals.backgroundSpawns.has("bg-new")).toBe(true);
  });

  test("in-flight (non-terminal) entries are NOT evicted — map may run over the soft cap", async () => {
    const MAX = _internals.MAX_BACKGROUND_SPAWNS;
    // Fill with in-flight (never terminal) entries.
    for (let i = 0; i < MAX; i++) {
      const asn = `live-${i}`;
      _internals.registerBackgroundSpawn(
        { assignmentId: asn, subConversationId: `sub-${asn}`, agentRunId: `run-${asn}`, taskId: `task-${asn}` },
        "builder",
        "agent-builder",
      );
    }
    // One more: no terminal entry to evict → the live one is kept; size = MAX+1.
    _internals.registerBackgroundSpawn(
      { assignmentId: "live-extra", subConversationId: "sub-extra", agentRunId: "run-extra", taskId: "task-extra" },
      "builder",
      "agent-builder",
    );
    expect(_internals.backgroundSpawns.size).toBe(MAX + 1);
    expect(_internals.backgroundSpawns.has("live-0")).toBe(true);
    expect(_internals.backgroundSpawns.has("live-extra")).toBe(true);
  });

  test("F5: eviction prefers a COLLECTED-terminal entry over an older uncollected-terminal one", async () => {
    _setSpawnForTests(makeFakeSpawn().fn);
    const MAX = _internals.MAX_BACKGROUND_SPAWNS;
    for (let i = 0; i < MAX; i++) {
      const asn = `bg-${i}`;
      _internals.registerBackgroundSpawn(
        { assignmentId: asn, subConversationId: `sub-${asn}`, agentRunId: `run-${asn}`, taskId: `task-${asn}` },
        "builder",
        "agent-builder",
        OWNER_CONV,
      );
      await _internals.handleAssignmentUpdate({
        conversationId: "conv-x",
        taskId: `task-${asn}`,
        assignment: { id: asn, status: "completed", resultPreview: "done" },
      });
    }
    // Collect a MIDDLE entry (bg-5) → marks it collected; bg-0..bg-4 stay
    // terminal-but-uncollected and are OLDER.
    const collected = await collect("bg-5");
    expect(expectIsError(collected)).toBe(false);
    expect(_internals.backgroundSpawns.get("bg-5")!.collected).toBe(true);
    expect(_internals.backgroundSpawns.get("bg-0")!.collected).toBe(false);

    // Register one more → the COLLECTED bg-5 is evicted first, NOT the older bg-0.
    _internals.registerBackgroundSpawn(
      { assignmentId: "bg-new", subConversationId: "sub-new", agentRunId: "run-new", taskId: "task-new" },
      "builder",
      "agent-builder",
      OWNER_CONV,
    );
    expect(_internals.backgroundSpawns.size).toBe(MAX);
    expect(_internals.backgroundSpawns.has("bg-5")).toBe(false); // collected → evicted first
    expect(_internals.backgroundSpawns.has("bg-0")).toBe(true); // older but uncollected → kept
    expect(_internals.backgroundSpawns.has("bg-new")).toBe(true);
  });
});
