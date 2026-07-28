/**
 * Settlement paths for `createExtensionPermissionGate`.
 *
 * Before this, the gate could ONLY be settled by `resolvePermission` — so
 * a gate opened where no human could answer it (a workflow run) parked a
 * promise until the process died. These tests pin the four ways it can
 * now settle, and the teardown that keeps `pendingApprovals` from leaking.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  beginNonInteractiveScope,
  createExtensionPermissionGate,
  getPendingApproval,
  getPendingApprovalConversation,
  NonInteractiveApprovalRequiredError,
  PermissionGateAbortedError,
  PermissionGateTimeoutError,
  resolvePermission,
  type ExtensionPermissionRequest,
} from "../runtime/tools/permissions";

let seq = 0;
function req(over: Partial<ExtensionPermissionRequest> = {}): ExtensionPermissionRequest {
  seq += 1;
  return {
    promptId: `prompt-${seq}`,
    conversationId: `conv-${seq}`,
    userId: "user-1",
    extensionId: "ext-1",
    toolName: "write_file",
    capabilityKind: "fs.write",
    ...over,
  };
}

// Any gate a test leaves pending would leak into the next one (the map is
// a module singleton) — settle by id explicitly in each test instead.
const opened: string[] = [];
afterEach(() => {
  for (const id of opened.splice(0)) resolvePermission(id, false);
});

describe("createExtensionPermissionGate — non-interactive scope", () => {
  test("refuses synchronously instead of parking a promise nobody can answer", async () => {
    const r = req({ capabilityKind: "shell" });
    const scope = beginNonInteractiveScope(r.conversationId);
    try {
      // The whole point: this settles WITHOUT anyone calling
      // resolvePermission, and without a pending entry being created.
      await expect(createExtensionPermissionGate(r)).rejects.toBeInstanceOf(
        NonInteractiveApprovalRequiredError,
      );
      expect(getPendingApproval(r.promptId)).toBe(false);
    } finally {
      scope.end();
    }
  });

  test("records the refused capability, and takeDenial() reports it exactly once", async () => {
    const r = req({ capabilityKind: "fs.write" });
    const scope = beginNonInteractiveScope(r.conversationId);
    try {
      await createExtensionPermissionGate(r).catch(() => {});
      expect(scope.takeDenial()).toBe("fs.write");
      // Consumed — a later step must not inherit an earlier step's denial.
      expect(scope.takeDenial()).toBeUndefined();
    } finally {
      scope.end();
    }
  });

  test("the rejection names the capability and the scope", async () => {
    const r = req({ capabilityKind: "shell" });
    const scope = beginNonInteractiveScope(r.conversationId);
    try {
      const err = await createExtensionPermissionGate(r).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonInteractiveApprovalRequiredError);
      expect((err as Error).message).toContain("shell");
      expect((err as Error).message).toContain(r.conversationId);
      expect((err as NonInteractiveApprovalRequiredError).capabilityKind).toBe("shell");
      expect((err as NonInteractiveApprovalRequiredError).scopeKey).toBe(r.conversationId);
    } finally {
      scope.end();
    }
  });

  test("a scope only covers its own key — other conversations still park normally", async () => {
    const scoped = req();
    const other = req();
    const scope = beginNonInteractiveScope(scoped.conversationId);
    try {
      const gate = createExtensionPermissionGate(other);
      opened.push(other.promptId);
      expect(getPendingApproval(other.promptId)).toBe(true);
      resolvePermission(other.promptId, true, "session");
      expect(await gate).toEqual({ allowed: true, scope: "session" });
    } finally {
      scope.end();
    }
  });

  test("ending the scope tears down a gate that was already pending under its key", async () => {
    const r = req();
    // Opened BEFORE the scope exists, so it got a real pending entry.
    const gate = createExtensionPermissionGate(r);
    expect(getPendingApproval(r.promptId)).toBe(true);

    const scope = beginNonInteractiveScope(r.conversationId);
    scope.end();

    await expect(gate).rejects.toBeInstanceOf(PermissionGateAbortedError);
    expect(getPendingApproval(r.promptId)).toBe(false);
  });

  test("aborting the scope's signal tears down its pending gates", async () => {
    const r = req();
    const gate = createExtensionPermissionGate(r);
    const ac = new AbortController();
    const scope = beginNonInteractiveScope(r.conversationId, ac.signal);
    try {
      ac.abort();
      await expect(gate).rejects.toBeInstanceOf(PermissionGateAbortedError);
      expect(getPendingApproval(r.promptId)).toBe(false);
    } finally {
      scope.end();
    }
  });
});

describe("createExtensionPermissionGate — timeout", () => {
  test("rejects with PermissionGateTimeoutError and drops the pending entry", async () => {
    const r = req({ timeoutMs: 5 });
    const gate = createExtensionPermissionGate(r);
    expect(getPendingApproval(r.promptId)).toBe(true);

    const err = await gate.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionGateTimeoutError);
    expect((err as PermissionGateTimeoutError).timeoutMs).toBe(5);
    expect((err as Error).message).toContain("5ms");
    expect(getPendingApproval(r.promptId)).toBe(false);
  });

  test("an answered gate is not later timed out", async () => {
    const r = req({ timeoutMs: 5 });
    const gate = createExtensionPermissionGate(r);
    resolvePermission(r.promptId, true, "forever");
    expect(await gate).toEqual({ allowed: true, scope: "forever" });
    // Past the timer's deadline: the answer must still stand.
    await new Promise((res) => setTimeout(res, 20));
    expect(getPendingApproval(r.promptId)).toBe(false);
  });

  test("no timeoutMs keeps the historical block-until-answered behaviour", async () => {
    const r = req();
    const gate = createExtensionPermissionGate(r);
    opened.push(r.promptId);
    await new Promise((res) => setTimeout(res, 20));
    // Still parked — nothing settled it.
    expect(getPendingApproval(r.promptId)).toBe(true);
    resolvePermission(r.promptId, false);
    expect(await gate).toEqual({ allowed: false });
  });
});

describe("createExtensionPermissionGate — abort signal", () => {
  test("an abort after creation rejects the gate", async () => {
    const ac = new AbortController();
    const r = req({ signal: ac.signal });
    const gate = createExtensionPermissionGate(r);
    expect(getPendingApproval(r.promptId)).toBe(true);
    ac.abort();
    await expect(gate).rejects.toBeInstanceOf(PermissionGateAbortedError);
    expect(getPendingApproval(r.promptId)).toBe(false);
  });

  test("an ALREADY-aborted signal rejects immediately (no 'abort' event to wait for)", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = req({ signal: ac.signal });
    await expect(createExtensionPermissionGate(r)).rejects.toBeInstanceOf(
      PermissionGateAbortedError,
    );
    expect(getPendingApproval(r.promptId)).toBe(false);
  });

  test("a gate answered before its signal fires keeps the answer", async () => {
    const ac = new AbortController();
    const r = req({ signal: ac.signal });
    const gate = createExtensionPermissionGate(r);
    resolvePermission(r.promptId, true, "session");
    expect(await gate).toEqual({ allowed: true, scope: "session" });
    ac.abort(); // no-op: cleanup already detached the listener
    expect(getPendingApproval(r.promptId)).toBe(false);
  });
});

describe("createExtensionPermissionGate — bookkeeping unchanged", () => {
  test("the gate still registers its conversation for the sec-H2 ownership check", async () => {
    const r = req();
    const gate = createExtensionPermissionGate(r);
    expect(getPendingApprovalConversation(r.promptId)).toBe(r.conversationId);
    resolvePermission(r.promptId, false);
    expect(await gate).toEqual({ allowed: false });
    expect(getPendingApprovalConversation(r.promptId)).toBeUndefined();
  });

  test("resolving an unknown id is still a no-op", () => {
    expect(() => resolvePermission("no-such-prompt", true)).not.toThrow();
  });
});
