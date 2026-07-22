import type { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { ExtensionRegistry } from "./registry";
import { registerFireCallProvenance } from "./call-provenance";

// ── Allowed Hooks ───────────────────────────────────────────────────

export const ALLOWED_LIFECYCLE_HOOKS = [
  "agent:spawn",
  "agent:complete",
  "run:start",
  "run:complete",
] as const;

export type LifecycleHookName = (typeof ALLOWED_LIFECYCLE_HOOKS)[number];

const allowedSet = new Set<string>(ALLOWED_LIFECYCLE_HOOKS);

// ── Sanitizers (ALLOWLIST — only named fields, coerced) ─────────────

type Sanitizer = (raw: Record<string, unknown>) => Record<string, unknown>;

/** `run:*` events ship a full `AgentRun` payload — pull only the ids we
 *  surface to extensions. Partial<AgentRun> covers the rare case of a
 *  malformed emit where one of the fields is missing; the `String(… ?? "")`
 *  fallbacks below still give every sanitised payload a stable shape. */
type RunPayload = { run?: Partial<AgentRun> };

const sanitizers: Record<LifecycleHookName, Sanitizer> = {
  "agent:spawn": (raw) => ({
    agentName: String(raw.agentName ?? ""),
    agentConfigId: String(raw.agentConfigId ?? ""),
    runId: String(raw.runId ?? ""),
    timestamp: Date.now(),
  }),
  "agent:complete": (raw) => ({
    agentName: String(raw.agentName ?? ""),
    agentConfigId: String(raw.agentConfigId ?? ""),
    runId: String(raw.runId ?? ""),
    success: Boolean(raw.success),
    timestamp: Date.now(),
  }),
  "run:start": (raw) => {
    const run = (raw as RunPayload).run;
    return {
      runId: String(run?.id ?? ""),
      agentName: String(run?.agentName ?? ""),
      timestamp: Date.now(),
    };
  },
  "run:complete": (raw) => {
    const run = (raw as RunPayload).run;
    return {
      runId: String(run?.id ?? ""),
      agentName: String(run?.agentName ?? ""),
      status: String(run?.status ?? ""),
      timestamp: Date.now(),
    };
  },
};

// ── Lifecycle Hook Dispatcher ───────────────────────────────────────

export class LifecycleHookDispatcher {
  /** extensionId -> set of subscribed hook names */
  private subscriptions = new Map<string, Set<LifecycleHookName>>();
  /** hook name -> set of extension IDs */
  private hookToExtensions = new Map<LifecycleHookName, Set<string>>();
  /** unsubscribe functions from EventBus */
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly bus: EventBus<AgentEvents>,
    private readonly registry: ExtensionRegistry,
  ) {}

  /**
   * Register an extension to receive specific lifecycle hooks.
   * Unknown hook names are silently ignored.
   */
  registerExtension(extensionId: string, hooks: LifecycleHookName[]): void {
    const validHooks = hooks.filter((h) => allowedSet.has(h));
    if (validHooks.length === 0) return;

    let extSubs = this.subscriptions.get(extensionId);
    if (!extSubs) {
      extSubs = new Set();
      this.subscriptions.set(extensionId, extSubs);
    }

    for (const hook of validHooks) {
      extSubs.add(hook);

      let extSet = this.hookToExtensions.get(hook);
      if (!extSet) {
        extSet = new Set();
        this.hookToExtensions.set(hook, extSet);
      }
      extSet.add(extensionId);
    }
  }

  /**
   * Subscribe to the EventBus for all hooks that have at least one subscriber.
   * On event, sanitizes the payload and sends fire-and-forget notifications.
   */
  start(): void {
    for (const hook of ALLOWED_LIFECYCLE_HOOKS) {
      const extSet = this.hookToExtensions.get(hook);
      if (!extSet || extSet.size === 0) continue;

      const unsub = this.bus.on(hook, (data: unknown) => {
        const sanitized = sanitizers[hook](data as Record<string, unknown>);
        for (const extId of extSet) {
          this.sendNotification(extId, hook, sanitized);
        }
      });

      this.unsubscribers.push(unsub);
    }
  }

  /**
   * Unsubscribe from all EventBus listeners.
   */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /**
   * Fire-and-forget notification to an extension's subprocess.
   * Only sends if the process is already running — never starts a sleeping process.
   */
  private sendNotification(
    extensionId: string,
    hookName: string,
    params: Record<string, unknown>,
  ): void {
    try {
      const proc = this.registry.getProcessIfRunning(extensionId);
      if (!proc) return;
      // Mint an OWNERLESS host-issued correlation token so a reverse-RPC the
      // lifecycle handler triggers resolves cleanly: a soft-fail (-32106) for
      // owner-scoped capabilities, and SUCCESS for install-wide global storage
      // (e.g. ECF's `run:complete` bookkeeping). Without it the reverse-RPC
      // has no valid `ezCallId` and fail-fasts `-32602` ("provenance
      // unresolved"). Lifecycle fires have no conversation or user by design,
      // so `ownerless: true`. The token auto-releases on the default 2-min
      // window (a lifecycle handler is fast + fire-and-forget).
      const ezCallId = registerFireCallProvenance({
        onBehalfOf: null,
        conversationId: null,
        runId: null,
        parentCallId: null,
        actorExtensionId: extensionId,
        kind: "event",
        ownerless: true,
      });
      proc.sendNotification(`lifecycle/${hookName}`, { ...params, _meta: { ezCallId } });
    } catch {
      // Gracefully ignore any errors — fire-and-forget
    }
  }
}
