import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import type { ExtensionRegistry } from "../registry";
import type { ExecuteToolCall } from "./errors";
import {
  MAX_CALL_DEPTH_PER_CONVERSATION,
  conversationCallDepth,
} from "./limits";
import { AUDIT_PERM_DENIED } from "../audit-actions";
import { insertAuditEntry } from "../../db/queries/audit-log";
import { getConversationExtensionIds } from "../../db/queries/conversation-extensions";
import {
  handleRuntimeInvoke,
  isRuntimeInvokeMethod,
} from "../runtime-invoke-handler";
import { getRuntimeToolContext } from "../runtime-tool-context";
import { grantsToCapabilitySet, intersect, type CapabilitySet } from "../capability-types";

/**
 * The `ToolExecutor` state the `ezcorp/invoke` cross-extension path
 * reads: the registry, the event-driven flag, the current call scope
 * singletons (read once, before dispatch), and the recursive
 * `executeToolCall` entry point.
 */
export interface InvokeHost {
  registry: ExtensionRegistry;
  eventDriven: boolean;
  currentConversationId: string | undefined;
  currentUserId: string | undefined;
  executeToolCall: ExecuteToolCall;
}

/**
 * Handle a ezcorp/invoke reverse RPC request from a subprocess.
 * Routes cross-extension calls through executeToolCall with caller context.
 */
export async function handlePiInvoke(
  host: InvokeHost,
  callerExtId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const tool = params.tool as string;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const depth = (params._depth as number) ?? 0;

  // Phase 54 SEC-03 — per-CHAIN cap (preserved). The pre-CC3 cap on
  // caller-supplied `_depth` still fails fast for a single runaway
  // chain. The new per-CONVERSATION cap layers on top to bound
  // parallel fan-out (50 chains can't collectively exhaust the
  // process by each going 10 levels deep).
  const MAX_CALL_DEPTH = 10;
  if (depth >= MAX_CALL_DEPTH) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: `Cross-extension call depth limit exceeded (max ${MAX_CALL_DEPTH})` },
    };
  }

  // Phase 54 SEC-03 — per-CONVERSATION cap. Compute `parentConvId`
  // BEFORE the body (the body re-uses the same value) so the cap
  // check and the executeToolCall dispatch agree on the key.
  // `cross-ext-<reqId>` is a synthetic id used when there's no parent
  // conversation; req.id is unique per request so the synthetic ids
  // don't collide. Increment here; decrement in `finally` below so
  // the slot is reusable after the call settles.
  const parentConvId = host.currentConversationId ?? `cross-ext-${req.id}`;
  const currentConvDepth = conversationCallDepth.get(parentConvId) ?? 0;
  if (currentConvDepth >= MAX_CALL_DEPTH_PER_CONVERSATION) {
    // Re-use AUDIT_PERM_DENIED with a structured `metadata.reason`
    // so audit-drilldown UI surfaces the cap event uniformly with
    // other PDP denies — no new audit-action constant needed.
    await insertAuditEntry(
      host.currentUserId ?? null,
      AUDIT_PERM_DENIED,
      callerExtId,
      {
        reason: "Per-conversation call-depth cap exceeded",
        conversationId: parentConvId,
        capabilityKind: "ezcorp:invoke",
        cap: MAX_CALL_DEPTH_PER_CONVERSATION,
        currentDepth: currentConvDepth,
      },
    ).catch(() => {
      /* audit best-effort, do not block the deny */
    });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32000,
        message: `Per-conversation call-depth cap exceeded (max ${MAX_CALL_DEPTH_PER_CONVERSATION})`,
      },
    };
  }
  conversationCallDepth.set(parentConvId, currentConvDepth + 1);

  try {
  // Phase 53 — `runtime.<area>.<verb>` invoke methods route through
  // the host-runtime dispatcher BEFORE the dep-tool table lookup.
  // These are read-only host helpers (conversation messages, lessons
  // trigger-gate, per-extension settings) that the lessons-distiller
  // bundled extension needs without the LLM-facing tool surface.
  // Cross-extension namespaced tools (`pkg__tool`) are unaffected.
  if (isRuntimeInvokeMethod(tool)) {
    const granted = host.registry.getGrantedPermissions(callerExtId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Caller extension not found in registry" },
      };
    }
    const manifest = host.registry.getManifest(callerExtId);
    // Per-call conversation-scope auth: thread the executor's
    // current conversation id (and acting user id) into the
    // RuntimeInvokeContext so `runtime.conversations.getMessages` /
    // `runtime.lessons.triggerGate` can enforce
    // `args.conversationId === ctx.currentConversationId`. Without
    // this, any installed extension could read messages from any
    // conversation across users — `conversation_extensions` wiring
    // is NOT consulted on the runtime-invoke fast path.
    const ctx = {
      extensionId: callerExtId,
      // Phase 53.4: thread the manifest name so `runtime.memory.compact`
      // / `runtime.memory.dedupMemoryWrite` can enforce their bundled-
      // only gate. Filled from the registry; never read from the
      // calling extension's params (spoofing defense).
      ...(manifest?.name ? { extensionName: manifest.name } : {}),
      userId: host.currentUserId ?? null,
      currentConversationId: host.currentConversationId ?? null,
      granted,
      ...(manifest?.settings ? { settingsSchema: manifest.settings } : {}),
      // Phase 53.7 — boot-spawn / event-driven path. The strict
      // conversation gate fails on this executor (no per-turn
      // currentConversationId), so the gate falls back to a
      // `conversation_extensions` wiring lookup keyed on the calling
      // extension's id — the same trust source the
      // EventSubscriptionDispatcher uses to decide WHO got the event.
      // Wiring lookup is a closure over the DB query so the handler
      // stays unit-testable without PGlite.
      ...(host.eventDriven
        ? {
            eventDriven: true as const,
            wiringLookup: async (conversationId: string, extensionId: string) => {
              const ids = await getConversationExtensionIds(conversationId);
              return ids.includes(extensionId);
            },
          }
        : {}),
    };
    return handleRuntimeInvoke(tool, args, ctx, req);
  }

  const resolved = host.registry.resolveDepTool(callerExtId, tool);
  // `tool` is a namespaced name like `foo__bar`; the package prefix is
  // everything before the first `__` (see registry's namespace separator).
  if (!resolved) {
    const pkgName = tool.includes("__") ? tool.split("__")[0] : tool;
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: `Dependency not declared: ${pkgName}` },
    };
  }

  // Phase 4 §M1 — full-chain chained-deputy attribution.
  //
  // ── v1.3 release-readiness security review (HIGH 3, 2026-05-09) ──
  //
  // The `acceptsCallerCaps` flag was originally documented (design
  // pillar 7 in `.planning/milestones/v1.3-permission-system-original-plan.md`
  // line 27) as the OPT-OUT marker: "deputies opt out via
  // `acceptsCallerCaps: true` to keep their own caps". Intersection
  // was meant to be the DEFAULT — closing the C1 confused-deputy
  // finding for every cross-extension call.
  //
  // The shipped Phase 4 code inverted that semantic: intersection
  // ran ONLY when the callee's GRANT carried `acceptsCallerCaps:
  // true`. Practical impact — a confused-deputy attack against any
  // non-deputy callee (A with no network → B with broad network →
  // A invokes B with malicious URL) was NOT prevented at the
  // intersection layer. The PDP authorized B's call against B's
  // installed grants, which already had the wide network surface.
  //
  // This block flips back to the design's stated default:
  //   - DEFAULT (acceptsCallerCaps absent or false): compute
  //     `capContext = intersect(callerCaps, calleeCaps)` and thread
  //     it through `executeToolCall`. The PDP receives the
  //     intersection and denies callee tool calls that exceed the
  //     caller's cap envelope. This closes the C1 confused-deputy
  //     gap for the wide majority of extensions.
  //   - OPT-OUT (`acceptsCallerCaps: true` on the callee's GRANT):
  //     `capContext` stays UNDEFINED. The PDP falls back to the
  //     callee's full installed grants — appropriate for a TRUSTED
  //     SHARED SERVICE that legitimately needs its own caps when
  //     invoked by less-privileged callers (e.g. the bundled
  //     `ai-kit` orchestration deputy). The flag now carries a
  //     "trust me" semantic that requires explicit user consent at
  //     install time (clamped via `clampExtensionPermissions`'s
  //     `manifestTopLevel.acceptsCallerCaps` gate).
  //
  // Bundled-extension sweep (2026-05-09): no bundled extension
  // currently declares `acceptsCallerCaps: true` in its manifest or
  // bundled-install grant. Pre-flip behavior under the OLD
  // semantics: NO bundled extension got intersection treatment
  // (intersection was opt-in). Post-flip behavior under the NEW
  // semantics: ALL bundled extensions get intersection treatment by
  // default. For every bundled extension reviewed, the new default
  // is correct — none of them are designed to receive widening
  // calls from less-privileged callers. If a future bundled
  // extension needs the opt-out, it must (a) declare
  // `acceptsCallerCaps: true` in its manifest, AND (b) be
  // explicitly granted via the install path.
  //
  // §M1 chained-deputy semantics still hold for the OPT-OUT branch:
  // if `currentCapContext` is set in the upstream runtime context,
  // we still respect the upstream chain — the deputy doesn't get
  // to LAUNDER a chain by sitting between two callers. (See
  // `cross-ext-attribution.test.ts` "M1 critical" assertion.)
  //
  // The check is `=== true` on the callee's GRANT, not its
  // manifest — a manifest declaring the flag without user consent
  // is treated as opted-out (spec lock-in: "runtime checks consult
  // the grant").
  //
  // See `tasks/v1.3-security-review.md` HIGH 3 for the full audit.
  const calleeGrants = host.registry.getGrantedPermissions(resolved.extensionId);
  const upstreamRuntimeCtx = getRuntimeToolContext();

  let capContext: CapabilitySet | undefined;
  if (calleeGrants?.acceptsCallerCaps !== true) {
    // DEFAULT (intersection-by-default). Flag absent or explicitly
    // false → compute `intersect(callerCaps, calleeCaps)`.
    //
    // Caller side: prefer the upstream effective caps when we're
    // inside a chain; fall back to caller's installed grants for
    // top-level invokes (top-level can't be a chain by definition).
    const callerCaps: CapabilitySet =
      upstreamRuntimeCtx?.currentCapContext ??
      grantsToCapabilitySet(host.registry.getGrantedPermissions(callerExtId) ?? null);
    const calleeCaps = grantsToCapabilitySet(calleeGrants ?? null);
    capContext = intersect(callerCaps, calleeCaps);
  }
  // OPT-OUT (`acceptsCallerCaps: true`): leave `capContext`
  // undefined so the PDP falls back to the callee's installed
  // grants. The user consented to this trust-elevation at install
  // time.

  // Phase 6 (finding M4) — propagate the real parent conversationId
  // through `ezcorp/invoke`. Pre-Phase-6 we passed the synthetic
  // `"cross-ext"` sentinel, which broke conversation-scoped checks
  // (storage scope, always-allow lookups, audit lineage) for any
  // cross-ext call. The parent's conversationId is whichever scope
  // we're already wired into — `currentConversationId` (set in
  // `executeToolCall` immediately before dispatch). `parentConvId`
  // is hoisted above (Phase 54 SEC-03) so the cap check and the
  // dispatch agree on the same key.
  const messageIdForCross = `cross-ext-${req.id}`;
  try {
    const result = await host.executeToolCall(
      resolved.name,
      args,
      parentConvId,
      messageIdForCross,
      {
        callerExtensionId: callerExtId,
        _callDepth: depth + 1,
        ...(capContext !== undefined ? { capContext } : {}),
        // Phase 4 §M2 — chain the audit id from the upstream
        // authorize. The inner executeToolCall will use it as
        // `parentAuditId` if `_opts.parentAuditId` isn't set. We
        // pass it explicitly so spawn-assignment + invoke chains
        // both flow through the same audit lineage even when the
        // ALS scope is dropped between async boundaries.
        ...(upstreamRuntimeCtx?.currentAuditId !== undefined
          ? { parentAuditId: upstreamRuntimeCtx.currentAuditId }
          : {}),
      },
    );

    return {
      jsonrpc: "2.0",
      id: req.id,
      result,
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  } finally {
    // Phase 54 SEC-03 — decrement on the way out. Lazy delete when
    // the count hits 0 so the Map doesn't grow unboundedly across
    // the process lifetime.
    const after = (conversationCallDepth.get(parentConvId) ?? 1) - 1;
    if (after <= 0) conversationCallDepth.delete(parentConvId);
    else conversationCallDepth.set(parentConvId, after);
  }
}
