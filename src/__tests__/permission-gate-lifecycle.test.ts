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
  abortPendingApprovalsForScope,
  beginNonInteractiveScope,
  createExtensionPermissionGate,
  createPermissionGate,
  getPendingApproval,
  getPendingApprovalConversation,
  NON_INTERACTIVE_KEY_PREFIX,
  NonInteractiveApprovalRequiredError,
  PermissionGateAbortedError,
  PermissionGateTimeoutError,
  refuseIfNonInteractive,
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

// ── The built-in gate: createPermissionGate(id, convId, opts?) ─────────
//
// The built-in gate used to park a bare promise with no timer, no signal
// and no cleanup, while `deferralReason` returned "pending permission"
// with no time bound — so an unanswered gate parked its run for the life
// of the process. It now takes the same bounds the extension gate has.
// OMITTING `opts` must reproduce the old behaviour exactly, which is what
// the first block below pins.

/** Settled-vs-parked probe. Cannot false-fail under load: a promise that
 *  is never going to settle cannot settle because the box was slow. */
async function settlement(p: Promise<unknown>): Promise<"resolved" | "rejected" | "parked"> {
  return await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"parked">((r) => setTimeout(() => r("parked"), 20)),
  ]);
}

let gateSeq = 0;
function gateId(): string {
  gateSeq += 1;
  return `builtin-gate-${gateSeq}`;
}

describe("createPermissionGate — no opts reproduces the historical gate", () => {
  test("parks until resolvePermission approves", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-a");
    expect(getPendingApproval(id)).toBe(true);
    expect(await settlement(gate)).toBe("parked");

    resolvePermission(id, true);
    expect(await gate).toBeUndefined();
    expect(getPendingApproval(id)).toBe(false);
  });

  test("rejects with the legacy 'Permission denied' error on deny", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-a");
    resolvePermission(id, false);
    const err = await gate.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Permission denied");
  });

  test("still registers its conversation for the sec-H2 ownership check", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-h2");
    expect(getPendingApprovalConversation(id)).toBe("conv-h2");
    resolvePermission(id, false);
    await gate.catch(() => {});
  });

  test("an omitted conversationId is still accepted and parks", async () => {
    const id = gateId();
    const gate = createPermissionGate(id);
    expect(getPendingApprovalConversation(id)).toBeUndefined();
    expect(getPendingApproval(id)).toBe(true);
    resolvePermission(id, true);
    await gate;
  });

  test("carries no hardReject: a scope abort drops the entry WITHOUT settling it", async () => {
    // The byte-for-byte pin. `abortPendingApprovalsForScope` calls
    // `pending.hardReject?.()`, which an unbounded built-in gate does not
    // have — so the entry vanishes and the promise stays parked, exactly
    // as it always has. A bounded gate does settle (next block).
    const id = gateId();
    const gate = createPermissionGate(id, "conv-scope-legacy");
    abortPendingApprovalsForScope("conv-scope-legacy");
    expect(getPendingApproval(id)).toBe(false);
    expect(await settlement(gate)).toBe("parked");
  });
});

describe("createPermissionGate — bounded by timeoutMs", () => {
  test("rejects PermissionGateTimeoutError and drops the pending entry", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-t", { timeoutMs: 5 });
    expect(getPendingApproval(id)).toBe(true);

    const err = await gate.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionGateTimeoutError);
    expect((err as PermissionGateTimeoutError).timeoutMs).toBe(5);
    expect(getPendingApproval(id)).toBe(false);
  });

  test("an answered gate is not later timed out", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-t", { timeoutMs: 5 });
    resolvePermission(id, true);
    expect(await gate).toBeUndefined();
    // Past the timer's deadline: the answer must still stand, and the
    // cleared timer must not re-settle an already-settled promise.
    await new Promise((res) => setTimeout(res, 20));
    expect(getPendingApproval(id)).toBe(false);
  });

  test("a bounded gate DOES settle loudly when its scope is aborted", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-scope-bounded", { timeoutMs: 60_000 });
    abortPendingApprovalsForScope("conv-scope-bounded");
    await expect(gate).rejects.toBeInstanceOf(PermissionGateAbortedError);
    expect(getPendingApproval(id)).toBe(false);
  });
});

describe("createPermissionGate — bounded by signal", () => {
  test("an abort after creation rejects the gate and drops the entry", async () => {
    const ac = new AbortController();
    const id = gateId();
    const gate = createPermissionGate(id, "conv-s", { signal: ac.signal });
    expect(getPendingApproval(id)).toBe(true);
    ac.abort();
    await expect(gate).rejects.toBeInstanceOf(PermissionGateAbortedError);
    expect(getPendingApproval(id)).toBe(false);
  });

  test("an ALREADY-aborted signal rejects immediately (no 'abort' event to wait for)", async () => {
    const ac = new AbortController();
    ac.abort();
    const id = gateId();
    await expect(
      createPermissionGate(id, "conv-s", { signal: ac.signal }),
    ).rejects.toBeInstanceOf(PermissionGateAbortedError);
    expect(getPendingApproval(id)).toBe(false);
  });

  test("a gate answered before its signal fires keeps the answer", async () => {
    const ac = new AbortController();
    const id = gateId();
    const gate = createPermissionGate(id, "conv-s", { signal: ac.signal });
    resolvePermission(id, true);
    expect(await gate).toBeUndefined();
    ac.abort(); // no-op: cleanup already detached the listener
    expect(getPendingApproval(id)).toBe(false);
  });
});

describe("createPermissionGate — nonInteractiveGuard", () => {
  test("refuses inside an ambient non-interactive scope and records the kind", async () => {
    const id = gateId();
    const scope = beginNonInteractiveScope("conv-ni");
    try {
      await expect(
        createPermissionGate(id, "conv-ni", { nonInteractiveGuard: "caller-tool" }),
      ).rejects.toBeInstanceOf(NonInteractiveApprovalRequiredError);
      expect(getPendingApproval(id)).toBe(false);
      expect(scope.takeDenial()).toBe("caller-tool");
    } finally {
      scope.end();
    }
  });

  test("refuses a workflow-run key that no live scope claims", async () => {
    const id = gateId();
    const err = await createPermissionGate(id, `${NON_INTERACTIVE_KEY_PREFIX}stale`, {
      nonInteractiveGuard: "caller-tool",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonInteractiveApprovalRequiredError);
    expect((err as Error).message).toContain("caller-tool");
    expect(getPendingApproval(id)).toBe(false);
  });

  test("an answerable conversation still parks normally", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, "conv-answerable", {
      nonInteractiveGuard: "caller-tool",
    });
    expect(getPendingApproval(id)).toBe(true);
    resolvePermission(id, true);
    await gate;
  });

  test("an omitted conversationId is treated as unnamed, not as a scope key", async () => {
    const id = gateId();
    const gate = createPermissionGate(id, undefined, { nonInteractiveGuard: "caller-tool" });
    expect(getPendingApproval(id)).toBe(true);
    resolvePermission(id, true);
    await gate;
  });

  test("UNSET keeps the historical behaviour: a built-in gate parks even in a scope", async () => {
    const id = gateId();
    const scope = beginNonInteractiveScope("conv-ni-unset");
    try {
      const gate = createPermissionGate(id, "conv-ni-unset");
      expect(getPendingApproval(id)).toBe(true);
      expect(await settlement(gate)).toBe("parked");
      expect(scope.takeDenial()).toBeUndefined();
      resolvePermission(id, true);
      await gate;
    } finally {
      scope.end();
    }
  });
});

describe("refuseIfNonInteractive", () => {
  test("returns undefined for a conversation a human can answer", () => {
    expect(refuseIfNonInteractive("conv-plain", "caller-tool")).toBeUndefined();
  });

  test("returns the error for a registered scope key and stamps the kind", () => {
    const scope = beginNonInteractiveScope("conv-refuse");
    try {
      const err = refuseIfNonInteractive("conv-refuse", "fs.write");
      expect(err).toBeInstanceOf(NonInteractiveApprovalRequiredError);
      expect(scope.takeDenial()).toBe("fs.write");
    } finally {
      scope.end();
    }
  });

  test("returns the error for the reserved workflow-run id space with no live scope", () => {
    const err = refuseIfNonInteractive(`${NON_INTERACTIVE_KEY_PREFIX}gone`, "shell");
    expect(err).toBeInstanceOf(NonInteractiveApprovalRequiredError);
    expect((err as NonInteractiveApprovalRequiredError).capabilityKind).toBe("shell");
  });
});
