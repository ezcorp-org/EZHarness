/**
 * Phase 4 — Cross-extension attribution matrix.
 *
 * Locks the confused-deputy gate from `tasks/phase-4-cross-ext-attribution.md`
 * §"NEW src/__tests__/cross-ext-attribution.test.ts" (matrix items a-i).
 *
 * Strategy: drive `handlePiInvoke` end-to-end against a stub registry +
 * a recording stub `PermissionEngine`. The recording stub captures the
 * `AuthorizeContext` of every authorize() call so we can assert the
 * engine SAW the post-intersection `capContext` (or didn't, depending
 * on opt-in).
 *
 * The actual deny/allow decision lives in the engine's subset check
 * (covered by `permission-engine.test.ts`). This file's contract is
 * narrower: assert that `handlePiInvoke` correctly threads
 * `capContext` based on the callee's `acceptsCallerCaps` GRANT.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { intersect, grantsToCapabilitySet } from "../extensions/capability-types";
import type { Capability, CapabilitySet } from "../extensions/capability-types";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../extensions/types";
import type {
  AuthorizeContext,
  Decision,
  PermissionEngine,
} from "../extensions/permission-engine";
import type { AlwaysAllowScope } from "../extensions/permissions";

// ── Recording engine stub ───────────────────────────────────────────

interface RecordingEngine extends PermissionEngine {
  readonly calls: Array<{ ctx: AuthorizeContext; needed: CapabilitySet }>;
  setMode(m: "allow-all" | "subset-check"): void;
}

/**
 * Two modes:
 *   - "allow-all"    : decision always allow; calls captured.
 *   - "subset-check" : if `ctx.capContext` is set, deny when any cap
 *                      in `needed` is missing from capContext. This
 *                      lets the matrix tests verify that intersection
 *                      really gates downstream calls.
 */
function makeRecordingEngine(): RecordingEngine {
  const calls: Array<{ ctx: AuthorizeContext; needed: CapabilitySet }> = [];
  let mode: "allow-all" | "subset-check" = "allow-all";

  const covers = (g: Capability, n: Capability) =>
    g.kind === n.kind && (g.value === n.value || (g.value === undefined && n.value === undefined));

  const eng: RecordingEngine = {
    calls,
    setMode(m) {
      mode = m;
    },
    async authorize(ctx, needed): Promise<Decision> {
      calls.push({ ctx, needed });
      const auditId = "rec-audit";
      if (mode === "allow-all") return { decision: "allow", auditId };
      // subset-check: only inspect capContext when present
      if (ctx.capContext) {
        for (const n of needed) {
          if (!ctx.capContext.some((g) => covers(g, n))) {
            return {
              decision: "deny",
              reason: `intersection missing ${n.kind}${n.value ? `:${n.value}` : ""}`,
              auditId,
              missing: n,
            };
          }
        }
      }
      return { decision: "allow", auditId };
    },
    async resolvePrompt(
      _id: string,
      _ok: boolean,
      _scope: AlwaysAllowScope,
      _scopeId: string,
    ): Promise<void> {},
    _resetCacheForTests(): void {
      calls.length = 0;
    },
  };
  return eng;
}

// ── Registry / manifest helpers ─────────────────────────────────────

function makeManifest(name: string, deputy: boolean): ExtensionManifestV2 {
  return {
    schemaVersion: 3,
    name,
    version: "1.0.0",
    description: "test",
    author: { name: "tester" },
    permissions: {},
    entrypoint: "./index.ts",
    tools: [
      {
        name: "doStuff",
        description: "does stuff",
        inputSchema: { type: "object" },
      },
    ],
    ...(deputy ? { acceptsCallerCaps: true } : {}),
  };
}

function setupTwoExtensions(
  registry: ExtensionRegistry,
  callerGrants: ExtensionPermissions,
  calleeGrants: ExtensionPermissions,
  calleeIsDeputy: boolean,
): void {
  registry.setManifestForTest("caller-id", makeManifest("caller", false));
  registry.setManifestForTest("callee-id", makeManifest("callee", calleeIsDeputy));
  registry.setGrantedPermsForTest("caller-id", callerGrants);
  registry.setGrantedPermsForTest("callee-id", calleeGrants);
  registry.setDepRoutes(new Map([
    ["caller-id", new Map([["callee", "callee-id"]])],
  ]));
  registry.registerToolForTest("callee__doStuff", {
    name: "callee__doStuff",
    originalName: "doStuff",
    description: "does stuff",
    inputSchema: { type: "object" },
    extensionId: "callee-id",
    extensionName: "callee",
  });
}

function makeInvoke(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "ezcorp/invoke",
    params: { tool: "callee__doStuff", arguments: {} },
  };
}

// ── Test setup ──────────────────────────────────────────────────────

let engine: RecordingEngine;
let executor: ToolExecutor;
let registry: ExtensionRegistry;

beforeEach(() => {
  ExtensionRegistry.resetInstance();
  registry = ExtensionRegistry.getInstance();
  engine = makeRecordingEngine();
  executor = new ToolExecutor(registry, engine);
});

afterEach(() => {
  ExtensionRegistry.resetInstance();
});

// ── Matrix items (a) - (b): Default behavior, acceptsCallerCaps absent ──
//
// v1.3 release-readiness security review (HIGH 3, 2026-05-09) flipped
// the default: intersection-by-default, opt-out via
// `acceptsCallerCaps: true`. Items (a) + (b) now assert the engine
// DOES receive a `capContext` when the flag is absent.

describe("(a) acceptsCallerCaps absent → INTERSECTION computed, PDP receives capContext (HIGH 3)", () => {
  test("PDP receives capContext = intersect(caller, callee) [foo.com]", async () => {
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com", "bar.com"], grantedAt: {} },
      false, // not a deputy — flag absent → DEFAULT = intersection
    );

    await executor.handlePiInvoke("caller-id", makeInvoke(1));

    expect(engine.calls.length).toBe(1);
    // Post-flip: capContext is the intersection of caller + callee
    // grants. caller=[foo], callee=[foo,bar] → [foo].
    expect(engine.calls[0]!.ctx.capContext).toEqual([
      { kind: "network", value: "foo.com" },
    ]);
  });
});

describe("(b) Non-deputy callee with empty grants → INTERSECTION is empty array, PDP narrows (HIGH 3)", () => {
  test("PDP gets capContext=[] when callee has no caps; engine denies any needed cap", async () => {
    // The callee's manifest declares no network. Pre-flip: capContext
    // was undefined → PDP fell back to callee's (empty) grants. Post-
    // flip: capContext = intersect(caller's [foo.com], callee's []) =
    // []. Same end result for this case (engine denies any needed cap),
    // but the SHAPE differs — the explicit empty intersection is the
    // signal a confused-deputy gate fired.
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { grantedAt: {} },
      false,
    );

    await executor.handlePiInvoke("caller-id", makeInvoke(2));

    expect(engine.calls[0]!.ctx.capContext).toEqual([]);
  });
});

// ── Matrix items (c) - (f): OPT-OUT (acceptsCallerCaps: true) behavior ──
//
// HIGH 3 flip: `acceptsCallerCaps: true` is now the OPT-OUT marker —
// callee bypasses caller's intersection and runs with its own
// installed grants. The user consented to this trust elevation at
// install time. These items lock the post-flip semantic.

describe("(c) Opt-OUT callee — flag set; PDP receives capContext=undefined; PDP uses callee's own grants", () => {
  test("acceptsCallerCaps: true → no intersection, callee runs with own grants → tool needs foo.com → ALLOWED", async () => {
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com", "bar.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    engine.setMode("subset-check");
    let observedCtx: AuthorizeContext | null = null;
    executor.executeToolCall = async (toolName, _input, conversationId, _messageId, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const ctx: AuthorizeContext = {
        extensionId: tool!.extensionId,
        userId: "test-user",
        conversationId,
        toolName: tool!.originalName,
        callerExtensionId: opts?.callerExtensionId,
        ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
      };
      observedCtx = ctx;
      const decision = await engine.authorize(ctx, [
        { kind: "network", value: "foo.com" },
      ]);
      if (decision.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: decision.reason }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const response = await executor.handlePiInvoke("caller-id", makeInvoke(3));
    expect(response.error).toBeUndefined();
    expect((response.result as any).isError).toBe(false);
    expect(observedCtx).not.toBeNull();
    // Post-flip: opt-out means capContext is undefined; the PDP falls
    // back to the callee's installed grants ([foo,bar]).
    expect(observedCtx!.capContext).toBeUndefined();
  });
});

describe("(d) Opt-OUT callee — needs bar.com (in callee's installed grants) → ALLOWED (no intersection narrows)", () => {
  test("acceptsCallerCaps: true keeps callee's installed [foo,bar] effective; bar.com allowed despite caller having only foo", async () => {
    // Pre-flip this case asserted DENIAL via intersection [foo]. Post-
    // flip the deputy is OPT-OUT → callee's full grants are used →
    // bar.com is in callee's installed list → ALLOWED.
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com", "bar.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, _input, conversationId, _messageId, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: "bar.com" }],
      );
      if (decision.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: decision.reason }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const response = await executor.handlePiInvoke("caller-id", makeInvoke(4));
    // Engine sees capContext=undefined → no subset-check fires →
    // ALLOW. (When PDP is wired in production, it falls back to the
    // callee's installed grants.)
    expect((response.result as any).isError).toBe(false);
    // Confirm: the call had no capContext, i.e. opt-out fired.
    expect(engine.calls.some((c) => c.ctx.capContext === undefined)).toBe(true);
  });
});

describe("(e) Opt-OUT callee — tool args supply URL not in callee's grants → DENIED on callee's own ceiling", () => {
  test("evil.com is in neither side's grants; engine denies on callee's installed list", async () => {
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com", "bar.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    // Subset-check mode only fires when capContext is set. With opt-
    // out, capContext is undefined → engine returns allow. We assert
    // a DIFFERENT contract for this case: the engine in production
    // would deny because evil.com isn't in callee's installed grants
    // (PDP fallback to registry grants), but our test stub doesn't
    // know about callee's grants. We assert capContext IS undefined
    // here and trust the production PDP's registry-fallback path
    // (covered by `permission-engine.test.ts`).
    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, _input, conversationId, _messageId, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const ctx: AuthorizeContext = {
        extensionId: tool!.extensionId,
        userId: "test-user",
        conversationId,
        toolName: tool!.originalName,
        callerExtensionId: opts?.callerExtensionId,
        ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
      };
      await engine.authorize(ctx, [{ kind: "network", value: "evil.com" }]);
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    await executor.handlePiInvoke("caller-id", makeInvoke(5));
    // Opt-out signal: capContext was undefined throughout.
    expect(engine.calls.every((c) => c.ctx.capContext === undefined)).toBe(true);
  });
});

describe("(f) Opt-OUT callee — caller has empty caps; callee opts out → callee runs with own [foo.com]", () => {
  test("acceptsCallerCaps: true bypasses caller's empty grants; callee's [foo.com] is the effective ceiling", async () => {
    // Pre-flip: empty intersection (caller=[], callee=[foo]) → DENY.
    // Post-flip: opt-out → no intersection → callee's own grants.
    setupTwoExtensions(
      registry,
      { grantedAt: {} },
      { network: ["foo.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, _input, conversationId, _messageId, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: "foo.com" }],
      );
      if (decision.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: decision.reason }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const response = await executor.handlePiInvoke("caller-id", makeInvoke(6));
    // Opt-out preserves callee's effective ceiling — foo.com allowed.
    expect((response.result as any).isError).toBe(false);
    expect(engine.calls[0]!.ctx.capContext).toBeUndefined();
  });
});

// ── Matrix item (g): depth limit fires regardless of attribution flag ──

describe("(g) Cross-ext call depth limit (10) fires regardless of acceptsCallerCaps", () => {
  test("depth=10 with deputy callee still rejects with -32000", async () => {
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "ezcorp/invoke",
      params: { tool: "callee__doStuff", arguments: {}, _depth: 10 },
    };

    const response = await executor.handlePiInvoke("caller-id", req);
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("depth");
    // No PDP authorize call should have been made — depth check is
    // enforced BEFORE the intersection logic.
    expect(engine.calls.length).toBe(0);
  });
});

// ── Matrix item (h): caller=undefined (top-level LLM call, not via invoke) ──

describe("(h) Top-level LLM call (no invoke wrapper) → no capContext synthesized regardless of flag", () => {
  test("Direct executeToolCall — opts={} → engine sees capContext=undefined, callerExtensionId=undefined", async () => {
    // Top-level LLM call enters via `executeToolCall`, NOT
    // `handlePiInvoke`. The intersection logic in handlePiInvoke
    // doesn't run — there's no caller to intersect against. Engine
    // sees a no-caller dispatch and falls back to the callee's
    // registry grants. Behavior is unchanged by the HIGH 3 flip
    // (the flip only affects handlePiInvoke).
    setupTwoExtensions(
      registry,
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com"], acceptsCallerCaps: true, grantedAt: {} },
      true,
    );

    // Stub the inner work so we don't dispatch to a real subprocess.
    executor.executeToolCall = async (toolName, _input, conversationId, _messageId, opts) => {
      // Simulate the engine call shape that the real path would take.
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: "foo.com" }],
      );
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    // Call directly — no callerExtensionId, no invoke wrapper
    await executor.executeToolCall(
      "callee__doStuff",
      {},
      "conv-1",
      "msg-1",
      // empty opts = top-level LLM call
    );

    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.ctx.capContext).toBeUndefined();
    expect(engine.calls[0]!.ctx.callerExtensionId).toBeUndefined();
  });
});

// ── Matrix item (i): chained NON-deputies — A → B → C (HIGH 3 default) ──
//
// HIGH 3 flipped intersection-by-default ON. Non-deputy chains now
// compose intersections at every step (the spec-locked §M1 full-chain
// semantic). Each callee receives `intersect(upstreamCapContext,
// calleeGrants)`. A no-cap caller cannot laundry-launder a chain into
// having any caps — the foundational confused-deputy property.

describe("(i) Chained NON-deputies (A → B → C, no flag) — full-chain intersection (HIGH 3)", () => {
  test("A=[foo,bar] → B=[foo,bar] → C=[foo] non-deputies → C sees intersect(intersect(A,B),C) = [foo]", async () => {
    // The runtime ALS context propagates the upstream `capContext`
    // through nested invokes. Production wraps inside `executeToolCall`;
    // our tests stub that, so we manually `withRuntimeToolContext` to
    // mirror the real dispatch site's wrapping.
    const { withRuntimeToolContext } = await import(
      "../extensions/runtime-tool-context"
    );

    // All three are NON-deputies (default, intersection-by-default).
    registry.setManifestForTest("a-id", makeManifest("a", false));
    registry.setManifestForTest("b-id", makeManifest("b", false));
    registry.setManifestForTest("c-id", makeManifest("c", false));

    registry.setGrantedPermsForTest("a-id", {
      network: ["foo.com", "bar.com"],
      grantedAt: {},
    });
    registry.setGrantedPermsForTest("b-id", {
      network: ["foo.com", "bar.com"],
      grantedAt: {},
    });
    registry.setGrantedPermsForTest("c-id", {
      network: ["foo.com"],
      grantedAt: {},
    });

    registry.setDepRoutes(new Map([
      ["a-id", new Map([["b", "b-id"]])],
      ["b-id", new Map([["c", "c-id"]])],
    ]));
    registry.registerToolForTest("b__doStuff", {
      name: "b__doStuff",
      originalName: "doStuff",
      description: "b tool",
      inputSchema: { type: "object" },
      extensionId: "b-id",
      extensionName: "b",
    });
    registry.registerToolForTest("c__doStuff", {
      name: "c__doStuff",
      originalName: "doStuff",
      description: "c tool",
      inputSchema: { type: "object" },
      extensionId: "c-id",
      extensionName: "c",
    });

    let observedAtoB: CapabilitySet | undefined;
    let observedBtoC: CapabilitySet | undefined;
    executor.executeToolCall = async (toolName, _input, _cid, _mid, opts) => {
      if (toolName === "b__doStuff") {
        observedAtoB = opts?.capContext;
      } else if (toolName === "c__doStuff") {
        observedBtoC = opts?.capContext;
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    // A → B (top-level — no upstream context)
    await executor.handlePiInvoke("a-id", {
      jsonrpc: "2.0",
      id: 9,
      method: "ezcorp/invoke",
      params: { tool: "b__doStuff", arguments: {} },
    });

    // A → B step: intersect(A's [foo,bar], B's [foo,bar]) = [foo, bar]
    const expectedAtoB = intersect(
      grantsToCapabilitySet({
        network: ["foo.com", "bar.com"],
        grantedAt: {},
      }),
      grantsToCapabilitySet({
        network: ["foo.com", "bar.com"],
        grantedAt: {},
      }),
    );
    expect(observedAtoB).toEqual(expectedAtoB);

    // B → C: production path — inner dispatch for B's tool runs with
    // `capContext = expectedAtoB` set in the runtime ALS scope. Next
    // handlePiInvoke reads it as the caller's effective set.
    await withRuntimeToolContext(
      { currentCapContext: expectedAtoB },
      async () => {
        await executor.handlePiInvoke("b-id", {
          jsonrpc: "2.0",
          id: 10,
          method: "ezcorp/invoke",
          params: { tool: "c__doStuff", arguments: {} },
        });
      },
    );

    // B → C step:
    //   capContext = intersect(intersect(A,B), C)
    //              = intersect([foo,bar], [foo])
    //              = [foo]
    expect(observedBtoC).toEqual([{ kind: "network", value: "foo.com" }]);
  });

  test("ATTACK: A=[] → B=[evil] → C=[evil] non-deputies → empty intersection narrows whole chain", async () => {
    // Confused-deputy attack against non-deputy callees. With HIGH 3
    // the default (intersection-by-default) holds at every step. A's
    // empty caps narrow B's intersection to []; the upstream-aware
    // §M1 logic reads the empty set as the caller's effective for
    // B → C, and intersect([], C's [evil]) = []. C never reaches evil.
    const { withRuntimeToolContext } = await import(
      "../extensions/runtime-tool-context"
    );

    // NON-deputies — default, intersection-by-default.
    registry.setManifestForTest("a-id", makeManifest("a", false));
    registry.setManifestForTest("b-id", makeManifest("b", false));
    registry.setManifestForTest("c-id", makeManifest("c", false));

    registry.setGrantedPermsForTest("a-id", { grantedAt: {} }); // EMPTY
    registry.setGrantedPermsForTest("b-id", {
      network: ["evil.com"],
      grantedAt: {},
    });
    registry.setGrantedPermsForTest("c-id", {
      network: ["evil.com"],
      grantedAt: {},
    });

    registry.setDepRoutes(new Map([
      ["a-id", new Map([["b", "b-id"]])],
      ["b-id", new Map([["c", "c-id"]])],
    ]));
    registry.registerToolForTest("b__doStuff", {
      name: "b__doStuff",
      originalName: "doStuff",
      description: "b tool",
      inputSchema: { type: "object" },
      extensionId: "b-id",
      extensionName: "b",
    });
    registry.registerToolForTest("c__doStuff", {
      name: "c__doStuff",
      originalName: "doStuff",
      description: "c tool",
      inputSchema: { type: "object" },
      extensionId: "c-id",
      extensionName: "c",
    });

    let observedAtoB: CapabilitySet | undefined;
    let observedBtoC: CapabilitySet | undefined;
    executor.executeToolCall = async (toolName, _input, _cid, _mid, opts) => {
      if (toolName === "b__doStuff") {
        observedAtoB = opts?.capContext;
      } else if (toolName === "c__doStuff") {
        observedBtoC = opts?.capContext;
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    // A → B: A has empty, B has [evil]. intersect([], [evil]) = []
    await executor.handlePiInvoke("a-id", {
      jsonrpc: "2.0",
      id: 11,
      method: "ezcorp/invoke",
      params: { tool: "b__doStuff", arguments: {} },
    });
    expect(observedAtoB).toEqual([]);

    // B → C: upstream capContext = []. intersect([], C's [evil]) = []
    await withRuntimeToolContext(
      { currentCapContext: observedAtoB ?? [] },
      async () => {
        await executor.handlePiInvoke("b-id", {
          jsonrpc: "2.0",
          id: 12,
          method: "ezcorp/invoke",
          params: { tool: "c__doStuff", arguments: {} },
        });
      },
    );
    expect(observedBtoC).toEqual([]);
    expect(observedBtoC).not.toContainEqual({ kind: "network", value: "evil.com" });
  });

  test("Top-level invoke (non-deputy callee, no upstream context) → caller's installed grants intersected with callee's", async () => {
    // No surrounding withRuntimeToolContext scope, no flag. Top-level
    // intersection-by-default uses the immediate caller's installed
    // grants (top-level can't be a chain). intersect(A's [foo], B's
    // [foo,bar]) = [foo].
    registry.setManifestForTest("a-id", makeManifest("a", false));
    registry.setManifestForTest("b-id", makeManifest("b", false));
    registry.setGrantedPermsForTest("a-id", {
      network: ["foo.com"],
      grantedAt: {},
    });
    registry.setGrantedPermsForTest("b-id", {
      network: ["foo.com", "bar.com"],
      grantedAt: {},
    });
    registry.setDepRoutes(new Map([
      ["a-id", new Map([["b", "b-id"]])],
    ]));
    registry.registerToolForTest("b__doStuff", {
      name: "b__doStuff",
      originalName: "doStuff",
      description: "b tool",
      inputSchema: { type: "object" },
      extensionId: "b-id",
      extensionName: "b",
    });

    let observed: CapabilitySet | undefined;
    executor.executeToolCall = async (_tn, _in, _cid, _mid, opts) => {
      observed = opts?.capContext;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    await executor.handlePiInvoke("a-id", {
      jsonrpc: "2.0",
      id: 13,
      method: "ezcorp/invoke",
      params: { tool: "b__doStuff", arguments: {} },
    });

    expect(observed).toEqual([{ kind: "network", value: "foo.com" }]);
  });
});

// ── Matrix item (j): HIGH 3 confused-deputy gate against NON-deputy ──

describe("(j) HIGH 3 — A no-network → B has network (NO acceptsCallerCaps flag) → PDP DENIES B's network call", () => {
  // The threat model the security review's HIGH 3 highlighted: a
  // less-privileged caller invokes a callee whose installed grants
  // include network access, but the callee did NOT declare itself
  // as a trusted shared service (`acceptsCallerCaps: true`). Pre-flip:
  // intersection didn't fire → the PDP authorized against B's full
  // installed grants → confused-deputy attack succeeded. Post-flip:
  // intersection IS the default → PDP receives an EMPTY capContext
  // (caller has no network) → DENY.
  test("Caller A has no network; non-deputy callee B has network; A→B network call DENIED at PDP", async () => {
    setupTwoExtensions(
      registry,
      { grantedAt: {} }, // A: empty caps
      { network: ["api.foo.com", "api.attacker.com"], grantedAt: {} }, // B: network, NO flag
      false, // NOT a deputy — flag absent → DEFAULT = intersection
    );
    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, args, conversationId, _mid, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const url = (args as { url?: string }).url ?? "api.attacker.com";
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: url }],
      );
      if (decision.decision === "deny") {
        return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const r = await executor.handlePiInvoke("caller-id", {
      jsonrpc: "2.0",
      id: 200,
      method: "ezcorp/invoke",
      params: { tool: "callee__doStuff", arguments: { url: "api.attacker.com" } },
    });
    // PDP DENIES via empty intersection — confused-deputy gate fires.
    expect((r.result as any).isError).toBe(true);
    expect((r.result as any).content[0].text).toContain("intersection missing network:api.attacker.com");

    // Audit chain: capContext is the empty set (caller has no network),
    // callerExtensionId points to the invoker.
    const denyCall = engine.calls.find(
      (c) => c.needed.some((n) => n.kind === "network" && n.value === "api.attacker.com"),
    );
    expect(denyCall).toBeDefined();
    expect(denyCall?.ctx.capContext).toEqual([]);
    expect(denyCall?.ctx.callerExtensionId).toBe("caller-id");
  });
});

// ── Confused-deputy integration test (HIGH 3 default — non-deputy callees) ──
//
// Pre-flip these tests used `acceptsCallerCaps: true` on the callee as
// the trigger for intersection. Post-flip the default IS intersection,
// and the flag is the OPT-OUT. The scenarios below now drive against
// NON-deputy callees so the test exercises the actual confused-deputy
// gate the security review highlighted (HIGH 3).

describe("CONFUSED-DEPUTY integration — A no-network → B with network (non-deputy) is gated by intersection (HIGH 3)", () => {
  test("A has no network, B has api.foo.com+api.evil.com (non-deputy) → A→B with URL=api.evil.com → DENY", async () => {
    setupTwoExtensions(
      registry,
      { grantedAt: {} }, // A: empty caps
      {
        network: ["api.foo.com", "api.evil.com"],
        grantedAt: {},
      },
      false, // NON-deputy — default intersection-by-default applies
    );
    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, args, conversationId, _mid, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const url = (args as { url?: string }).url ?? "api.evil.com";
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: url }],
      );
      if (decision.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: decision.reason }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const r = await executor.handlePiInvoke("caller-id", {
      jsonrpc: "2.0",
      id: 100,
      method: "ezcorp/invoke",
      params: { tool: "callee__doStuff", arguments: { url: "api.evil.com" } },
    });
    expect((r.result as any).isError).toBe(true);
    expect((r.result as any).content[0].text).toContain("intersection missing network:api.evil.com");

    // N3 — audit row assertion. The recording engine captures every
    // authorize call; we inspect what would have been written to
    // auditLog as a denial (the production engine writes a
    // `ext:perm:denied` row with metadata.reason matching this
    // shape — see permission-engine.ts writeAuditRow).
    expect(engine.calls.length).toBeGreaterThanOrEqual(1);
    const denyCall = engine.calls.find(
      (c) => c.ctx.capContext !== undefined &&
        c.needed.some((n) => n.kind === "network" && n.value === "api.evil.com"),
    );
    expect(denyCall).toBeDefined();
    // The intersection (capContext) should be EMPTY (caller has no
    // network grants) — that's why the deny fires. The audit row's
    // ctx.capContext is the same as what the engine saw.
    expect(denyCall?.ctx.capContext).toEqual([]);
    expect(denyCall?.ctx.callerExtensionId).toBe("caller-id");
  });

  test("A still has no network, B same → URL=api.foo.com → DENY (A's intersection with B is empty)", async () => {
    setupTwoExtensions(
      registry,
      { grantedAt: {} }, // A still empty
      {
        network: ["api.foo.com", "api.evil.com"],
        grantedAt: {},
      },
      false, // NON-deputy
    );
    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, args, conversationId, _mid, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const url = (args as { url?: string }).url ?? "api.foo.com";
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: url }],
      );
      if (decision.decision === "deny") {
        return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const r = await executor.handlePiInvoke("caller-id", {
      jsonrpc: "2.0",
      id: 101,
      method: "ezcorp/invoke",
      params: { tool: "callee__doStuff", arguments: { url: "api.foo.com" } },
    });
    expect((r.result as any).isError).toBe(true);
  });

  test("A=api.foo.com, B same non-deputy → URL=api.foo.com → ALLOWED (intersection contains it)", async () => {
    setupTwoExtensions(
      registry,
      { network: ["api.foo.com"], grantedAt: {} }, // A now has the host
      {
        network: ["api.foo.com", "api.evil.com"],
        grantedAt: {},
      },
      false, // NON-deputy
    );
    engine.setMode("subset-check");
    executor.executeToolCall = async (toolName, args, conversationId, _mid, opts) => {
      const reg = ExtensionRegistry.getInstance();
      const tool = reg.getRegisteredTool(toolName);
      const url = (args as { url?: string }).url ?? "api.foo.com";
      const decision = await engine.authorize(
        {
          extensionId: tool!.extensionId,
          userId: "test-user",
          conversationId,
          toolName: tool!.originalName,
          callerExtensionId: opts?.callerExtensionId,
          ...(opts?.capContext !== undefined ? { capContext: opts.capContext } : {}),
        },
        [{ kind: "network", value: url }],
      );
      if (decision.decision === "deny") {
        return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
      }
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const r = await executor.handlePiInvoke("caller-id", {
      jsonrpc: "2.0",
      id: 102,
      method: "ezcorp/invoke",
      params: { tool: "callee__doStuff", arguments: { url: "api.foo.com" } },
    });
    expect(r.error).toBeUndefined();
    expect((r.result as any).isError).toBe(false);
  });
});
