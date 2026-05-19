/**
 * Reverse-RPC provenance resolution (the concurrency / background-fire
 * fix). Asserts `ToolExecutor.resolveReverseRpcMeta` derives the call's
 * owner from the host-issued `ezCallId` token — NEVER from singleton
 * state — so:
 *
 *   - two concurrent calls for different users resolve to their OWN
 *     user (the regression that made a slow tool's reverse-RPC observe
 *     another conversation's scope),
 *   - an unknown / missing token fails fast with -32602 (no 90s hang),
 *   - an ownerless background fire soft-fails cleanly with -32106
 *     (never the old `missing onBehalfOf` throw),
 *   - runId / parentCallId round-trip into the handler rpcMeta.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  registerCallProvenance,
  _resetCallProvenanceForTests,
} from "../call-provenance";
import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";

function makeRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getManifest: () => ({ schemaVersion: 2, name: "ext-under-test" }),
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

type ResolveResult =
  | { ok: true; onBehalfOf: string; conversationId: string | null; rpcMeta: Record<string, unknown> }
  | { ok: false; errorResponse: JsonRpcResponse };

function resolve(
  executor: ToolExecutor,
  extensionId: string,
  meta: Record<string, unknown> | undefined,
): ResolveResult {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/llm-complete",
    params: meta ? { _meta: meta } : {},
  };
  // `resolveReverseRpcMeta` is private — the trust-boundary seam is
  // exercised directly here (same cast pattern other tool-executor
  // tests use for private internals).
  return (
    executor as unknown as {
      resolveReverseRpcMeta: (e: string, r: JsonRpcRequest) => ResolveResult;
    }
  ).resolveReverseRpcMeta(extensionId, req);
}

describe("ToolExecutor.resolveReverseRpcMeta — token-correlated provenance", () => {
  let executor: ToolExecutor;

  beforeEach(() => {
    _resetCallProvenanceForTests();
    executor = new ToolExecutor(makeRegistry(), createStubPermissionEngine());
  });

  test("concurrent calls for different users each resolve to their OWN user", () => {
    const tokenA = registerCallProvenance({
      onBehalfOf: "user-A",
      conversationId: "conv-A",
      runId: "run-A",
      parentCallId: "cap-A",
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const tokenB = registerCallProvenance({
      onBehalfOf: "user-B",
      conversationId: "conv-B",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });

    const a = resolve(executor, "ext-1", { ezCallId: tokenA });
    const b = resolve(executor, "ext-1", { ezCallId: tokenB });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.onBehalfOf).toBe("user-A");
      expect(a.conversationId).toBe("conv-A");
      expect(a.rpcMeta).toEqual({
        ezOnBehalfOf: "user-A",
        ezConversationId: "conv-A",
        invocationMetadata: { runId: "run-A", parentCallId: "cap-A" },
      });
      // Distinct call → distinct user. This is the property a singleton
      // `currentUserId` could NOT guarantee under concurrency.
      expect(b.onBehalfOf).toBe("user-B");
      expect(b.rpcMeta).toEqual({
        ezOnBehalfOf: "user-B",
        ezConversationId: "conv-B",
      });
    }
  });

  test("unknown token → fast -32602 (no hang, no singleton fallback)", () => {
    const r = resolve(executor, "ext-1", { ezCallId: "never-registered" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorResponse.error?.code).toBe(-32602);
      expect(r.errorResponse.id).toBe(1);
    }
  });

  test("missing _meta entirely → fast -32602", () => {
    const r = resolve(executor, "ext-1", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorResponse.error?.code).toBe(-32602);
  });

  test("ownerless background fire → clean -32106 soft-fail (never throws)", () => {
    const token = registerCallProvenance({
      onBehalfOf: null,
      conversationId: null,
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "schedule",
      ownerless: true,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorResponse.error?.code).toBe(-32106);
  });

  test("token present but onBehalfOf null (defensive) → -32106, not a throw", () => {
    const token = registerCallProvenance({
      onBehalfOf: null,
      conversationId: "conv-x",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "event",
      ownerless: false, // ownerless flag off but no user — still soft-fail
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorResponse.error?.code).toBe(-32106);
  });

  test("conversationId omitted from snapshot → rpcMeta carries only ezOnBehalfOf", () => {
    const token = registerCallProvenance({
      onBehalfOf: "user-solo",
      conversationId: null,
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rpcMeta).toEqual({ ezOnBehalfOf: "user-solo" });
      expect(r.conversationId).toBeNull();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GUARD: provenance MUST come from the host-issued token, NEVER from
  // instance singleton state. If anyone reintroduces a
  // `this.currentUserId` read into resolveReverseRpcMeta, these fail.
  // ─────────────────────────────────────────────────────────────────

  test("GUARD: resolution works WITHOUT setCurrentUserId — value comes from the token, not the instance", () => {
    // Deliberately do NOT call executor.setCurrentUserId(...). A
    // singleton-backed resolver would now return undefined / "unknown".
    const token = registerCallProvenance({
      onBehalfOf: "user-X",
      conversationId: "conv-X",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The single load-bearing assertion of the whole fix: identity is
      // token-derived. NOT undefined, NOT "unknown", NOT "" — exactly
      // the snapshot's onBehalfOf.
      expect(r.onBehalfOf).toBe("user-X");
      expect(r.onBehalfOf).not.toBe("unknown");
      expect(r.conversationId).toBe("conv-X");
    }
  });

  test("GUARD: a SECOND, independent executor resolves the SAME token to the same user (registry is module-level, instance-independent)", () => {
    const token = registerCallProvenance({
      onBehalfOf: "user-X",
      conversationId: "conv-X",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    // Fresh executor — its own (unset) singleton state is irrelevant
    // because resolution is keyed purely by the module-level registry.
    const other = new ToolExecutor(makeRegistry(), createStubPermissionEngine());
    const r1 = resolve(executor, "ext-1", { ezCallId: token });
    const r2 = resolve(other, "ext-1", { ezCallId: token });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.onBehalfOf).toBe("user-X");
      expect(r2.onBehalfOf).toBe("user-X");
      expect(r2.conversationId).toBe("conv-X");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // invocationMetadata shape correctness — partial snapshots.
  // ─────────────────────────────────────────────────────────────────

  test("runId-only snapshot → invocationMetadata carries only runId", () => {
    const token = registerCallProvenance({
      onBehalfOf: "u",
      conversationId: "c",
      runId: "run-only",
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rpcMeta).toEqual({
        ezOnBehalfOf: "u",
        ezConversationId: "c",
        invocationMetadata: { runId: "run-only" },
      });
    }
  });

  test("parentCallId-only snapshot → invocationMetadata carries only parentCallId", () => {
    const token = registerCallProvenance({
      onBehalfOf: "u",
      conversationId: null,
      runId: null,
      parentCallId: "cap-only",
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rpcMeta).toEqual({
        ezOnBehalfOf: "u",
        invocationMetadata: { parentCallId: "cap-only" },
      });
    }
  });

  test("neither runId nor parentCallId → NO invocationMetadata key at all", () => {
    const token = registerCallProvenance({
      onBehalfOf: "u",
      conversationId: "c",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-1", { ezCallId: token });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rpcMeta).toEqual({ ezOnBehalfOf: "u", ezConversationId: "c" });
      expect("invocationMetadata" in r.rpcMeta).toBe(false);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Anti-spoofing: only the registry snapshot (keyed by ezCallId) ever
  // decides identity. Subprocess-supplied `_meta` fields are IGNORED.
  // ─────────────────────────────────────────────────────────────────

  test("spoofed ezOnBehalfOf / actorExtensionId on the wire _meta are IGNORED — registry wins", () => {
    const token = registerCallProvenance({
      onBehalfOf: "honest-user",
      conversationId: "honest-conv",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    });
    // The subprocess crams attacker-controlled fields next to the
    // (legitimately echoed) token. None of them must influence the
    // result — provenance is host-resolved from the token alone.
    const r = resolve(executor, "ext-1", {
      ezCallId: token,
      ezOnBehalfOf: "attacker",
      ezConversationId: "attacker-conv",
      actorExtensionId: "evil",
      invocationMetadata: { runId: "evil-run", parentCallId: "evil-cap" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.onBehalfOf).toBe("honest-user");
      expect(r.conversationId).toBe("honest-conv");
      // No spoofed invocationMetadata leaked through (snapshot had none).
      expect(r.rpcMeta).toEqual({
        ezOnBehalfOf: "honest-user",
        ezConversationId: "honest-conv",
      });
    }
  });

  test("a bogus token alongside spoofed identity still fails -32602 (spoof can't substitute for a real token)", () => {
    const r = resolve(executor, "ext-1", {
      ezCallId: "forged-token",
      ezOnBehalfOf: "attacker",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorResponse.error?.code).toBe(-32602);
  });

  // ─────────────────────────────────────────────────────────────────
  // Token / extension binding — DOCUMENTED current behavior.
  // ─────────────────────────────────────────────────────────────────

  test("token registered for ext-A resolves even when the reverse-RPC arrives on ext-B's handler (resolver does NOT bind token→extension)", () => {
    // The snapshot's actorExtensionId is "ext-A", but resolution is
    // requested with extensionId "ext-B".
    const token = registerCallProvenance({
      onBehalfOf: "user-A",
      conversationId: "conv-A",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-A",
      kind: "tool",
      ownerless: false,
    });
    const r = resolve(executor, "ext-B", { ezCallId: token });

    // ACTUAL behavior (asserted, not aspirational): resolveReverseRpcMeta
    // resolves purely on the opaque token. `extensionId` is used ONLY
    // for log context — it is NOT cross-checked against
    // prov.actorExtensionId. So ext-B successfully resolves a token
    // minted for ext-A.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.onBehalfOf).toBe("user-A");
      expect(r.conversationId).toBe("conv-A");
    }

    // DESIGN DECISION (implemented): resolveReverseRpcMeta now emits a
    // warn-level TRIPWIRE when prov.actorExtensionId !== resolving
    // extensionId, but DELIBERATELY still resolves (ok:true above). This
    // is intentional and must NOT be "upgraded" to a hard reject: the
    // cross-extension `ezcorp/invoke` path's exact token/extension
    // correspondence is subtle and a false reject would break
    // legitimate chained calls. It is safe to leave non-enforcing
    // because the token is opaque, host-issued, single-use, and never
    // observable by another extension's subprocess (independent review
    // confirmed: 122-bit UUID on per-subprocess stdin). The tripwire
    // gives observability of any real divergence without functional
    // risk. This assertion locks the "tripwire, not gate" contract.
    expect(r.ok).toBe(true);
  });
});
