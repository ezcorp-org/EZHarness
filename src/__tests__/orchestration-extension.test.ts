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
  _resetBindingsForTests,
  _internals,
} from "../../docs/extensions/examples/orchestration/index";
import type { SpawnAssignmentInput, SpawnAssignmentHandle } from "@ezcorp/sdk/runtime";

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

beforeEach(() => {
  fakeAgents = new FakeAgentConfigs([
    { id: "agent-builder", name: "builder", description: "Builds things" },
    { id: "agent-writer", name: "writer", description: "Writes things" },
  ]);
  _setAgentConfigsForTests(fakeAgents);
  // Default: identity-passthrough spawn. Tests that need specific
  // behavior override via _setSpawnForTests.
  _setDefaultTimeoutMsForTests(60_000);
  _internals.pendingInvocations.clear();
});

afterEach(() => {
  _resetBindingsForTests();
  _setDefaultTimeoutMsForTests(60_000);
  _internals.pendingInvocations.clear();
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

// ── invoke_agent — non-terminal status no-op ───────────────────────

describe("orchestration extension — non-terminal status no-op", () => {
  test("non-terminal status for a known assignmentId leaves pending entry intact; subsequent terminal resolves normally", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const invocation = tools.invoke_agent!({ agentConfigId: "agent-builder", task: "go" });

    // Wait for the pending entry to appear.
    let assignmentId: string | undefined;
    for (let i = 0; i < 20 && !assignmentId; i++) {
      await new Promise((r) => setTimeout(r, 1));
      assignmentId = Array.from(_internals.pendingInvocations.keys())[0];
    }
    expect(assignmentId).toBeDefined();

    const before = _internals.pendingInvocations.get(assignmentId!);
    expect(before).toBeDefined();
    const timerBefore = before!.timeoutHandle;

    // Fire a non-terminal status against the same assignmentId — this
    // drives the `status !== "completed" && status !== "failed"` early
    // return at orchestration/index.ts:246. The pending entry must NOT
    // be deleted, its timer must NOT be cleared, and the invocation
    // promise must NOT resolve.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "running", resultPreview: "still working" },
    });

    // Pending entry still present, exact same object + same timer.
    const after = _internals.pendingInvocations.get(assignmentId!);
    expect(after).toBeDefined();
    expect(after).toBe(before);
    expect(after!.timeoutHandle).toBe(timerBefore);
    expect(_internals.pendingInvocations.size).toBe(1);

    // Invocation promise did NOT resolve — race it against a microtask
    // sentinel and confirm the sentinel wins.
    const sentinel = Symbol("not-resolved");
    const raceResult = await Promise.race([
      Promise.resolve(invocation).then(() => "resolved" as const),
      Promise.resolve(sentinel),
    ]);
    expect(raceResult).toBe(sentinel);

    // Fire a second non-terminal status — still a no-op.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: "task-x",
      assignment: { id: assignmentId!, status: "assigned" },
    });
    expect(_internals.pendingInvocations.size).toBe(1);

    // Now fire the terminal status — the state from the non-terminal
    // drops should not have corrupted anything; invocation resolves
    // with the terminal's resultPreview.
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

  test("no metadata fields forwarded when invocationMetadata is absent", async () => {
    const input = await run(undefined);
    expect(input.parentMessageId).toBeUndefined();
    expect(input.overrides).toBeUndefined();
    expect(input.teamToolScope).toBeUndefined();
    expect(input.orchestrationDepth).toBeUndefined();
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
