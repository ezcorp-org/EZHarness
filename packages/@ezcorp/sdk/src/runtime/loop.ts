// ── defineLoop — the Loop SDK primitive (extension facade) ──────────
//
// ONE declarative call collapses the boilerplate every autonomous SDK
// loop hand-rolls: settings resolution, the run-record + status state
// machine, idempotency, retention, failure policy, fire logging, and
// (opt-in) a Hub dashboard. The author writes only `act` (what to do) +
// small config.
//
// This module is the I/O-bearing facade: it composes the pure state
// machine (`loop-core`), the Storage-backed run store (`loop-store`), and
// the existing SDK trigger primitives (`Schedule`, `registerEventHandler`,
// `createToolDispatcher`, `definePage`/`pushPage`). It owns NO new
// transport and NO host table — run-state is Storage (spec decision #1/#2).
//
// Phase 2 ships trigger wiring + the run store + the deferred state
// machine + the shared helpers. Phase 3 layers the `log` artifact mirror
// and the dashboard helper on top (see `wireDashboard` / `writeArtifact`,
// added there).

import { Schedule, type ScheduleHandlerContext } from "./schedule";
import { registerEventHandler } from "./events";
import { createToolDispatcher, toolError, toolResult } from "./rpc";
import { definePage, pushPage } from "./page";
import { Llm } from "./llm";
import { invoke } from "./invoke";
import { spawnAssignment } from "./spawn";
import {
  autoDisableContext,
  classifyFailure,
  resolveContract,
  validateActResult,
} from "./loop-core";
import { createLoopRunStore, type LoopRunStore } from "./loop-store";
import { wireLog, runTerminalLog } from "./loop-log";
import type {
  ActResult,
  LoopActContext,
  LoopDefinition,
  LoopMessage,
  LoopRunState,
  LoopSettings,
  LoopTrigger,
  ResolvedContract,
} from "./loop-types";
import type { TaskAssignmentUpdateEvent } from "./host-event-types";
import type { ToolHandler, ToolHandlerContext } from "./rpc";

// ── Centralized provider → default-model map ────────────────────────
//
// The SINGLE copy of the provider-default map that lessons-distiller and
// memory-extractor each duplicated. Loops resolve the effective
// provider/model from settings via `resolveProviderModel`, deleting the
// per-extension copies (spec decision #6, the DRY win).
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  google: "gemini-2.0-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20250514",
  ollama: "gemma4:e2b",
};

/** Fallback provider when the setting is unset / unrecognized. */
export const DEFAULT_PROVIDER = "google";

/**
 * Resolve `{ provider, model }` from optional settings, applying the
 * shared default map. Any valid provider override wins; a blank/unknown
 * provider falls back to `google`; a blank model falls back to the
 * provider default. Pure. (Lifted verbatim from the two extensions so the
 * migration is behavior-preserving.)
 */
export function resolveProviderModel(
  providerSetting: string | undefined,
  modelSetting: string | undefined,
): { provider: string; model: string } {
  const provider =
    providerSetting && PROVIDER_DEFAULT_MODEL[providerSetting]
      ? providerSetting
      : DEFAULT_PROVIDER;
  const model =
    modelSetting && modelSetting.length > 0
      ? modelSetting
      : (PROVIDER_DEFAULT_MODEL[provider] ?? PROVIDER_DEFAULT_MODEL[DEFAULT_PROVIDER]!);
  return { provider, model };
}

// ── Shared act-context helpers (the §2 "yes" rows) ──────────────────

/** Effective settings for this extension on behalf of the acting user,
 *  with a `{}` fallback already applied (replaces every loop's
 *  hand-rolled try/catch). Injectable for tests. */
export type SettingsResolver = () => Promise<LoopSettings>;

const defaultSettingsResolver: SettingsResolver = async () => {
  try {
    return await invoke<LoopSettings>("runtime.settings.getMine", {});
  } catch {
    return {};
  }
};

/** Fetch + slice + format recent messages (replaces the verbatim
 *  last-20 code). Injectable for tests. */
export type MessagesResolver = (
  conversationId: string,
) => Promise<{ messages: LoopMessage[]; projectId: string | null }>;

const defaultMessagesResolver: MessagesResolver = async (conversationId) => {
  const result = await invoke<{
    messages: LoopMessage[];
    projectId?: string | null;
  }>("runtime.conversations.getMessages", { conversationId });
  return { messages: result.messages, projectId: result.projectId ?? null };
};

/** Canonical `[id] role: content` formatting — the shared slice format. */
export function formatMessages(messages: LoopMessage[]): string {
  return messages.map((m) => `[${m.id}] ${m.role}: ${m.content}`).join("\n\n");
}

// ── Module-level seams (test injection) ─────────────────────────────
//
// Mirrors the pattern the example extensions use (`_setRuntimeApiForTests`).
// Production wiring uses the channel-backed defaults; tests swap these to
// avoid a live pipe while still exercising the real facade logic.

let settingsResolverImpl: SettingsResolver = defaultSettingsResolver;
let messagesResolverImpl: MessagesResolver = defaultMessagesResolver;
let spawnImpl: typeof spawnAssignment = spawnAssignment;
let llmFactory: () => Llm = () => new Llm();
let storeFactory:
  | (<O>(loopId: string, contract: ResolvedContract) => LoopRunStore<O>)
  | null = null;

/** @internal test-only — override the settings resolver. */
export function _setSettingsResolverForTests(fn: SettingsResolver | null): void {
  settingsResolverImpl = fn ?? defaultSettingsResolver;
}
/** @internal test-only — override the recent-messages resolver. */
export function _setMessagesResolverForTests(fn: MessagesResolver | null): void {
  messagesResolverImpl = fn ?? defaultMessagesResolver;
}
/** @internal test-only — override the spawn dispatcher. */
export function _setSpawnForTests(fn: typeof spawnAssignment | null): void {
  spawnImpl = fn ?? spawnAssignment;
}
/** @internal test-only — override the Llm factory. */
export function _setLlmFactoryForTests(fn: (() => Llm) | null): void {
  llmFactory = fn ?? (() => new Llm());
}
/** @internal test-only — substitute the run store (in-memory KV). */
export function _setStoreFactoryForTests(
  fn:
    | (<O>(loopId: string, contract: ResolvedContract) => LoopRunStore<O>)
    | null,
): void {
  storeFactory = fn;
}

// ── Registry (multi-loop-per-extension) ─────────────────────────────
//
// One extension may declare N loops (memory-extractor needs 2). Each
// `defineLoop` registers an independent handle here; the deferred
// `task:assignment_update` dispatcher fans an inbound event to whichever
// loop owns the matching open run.

interface RegisteredLoop {
  id: string;
  contract: ResolvedContract;
  store: LoopRunStore;
  def: LoopDefinition;
  /** Phase-3 dashboard pusher, wired when `log.dashboard` is present. */
  pushDashboard?: () => Promise<void>;
}

const registry = new Map<string, RegisteredLoop>();
let assignmentHandlerInstalled = false;

/** Accumulated manual-trigger tool handlers across every loop in this
 *  extension. Exposed via `getLoopTools()` so an extension that hand-writes
 *  its own tools can merge them into a single `createToolDispatcher`. */
const loopToolHandlers: Record<string, ToolHandler> = {};

/** Return the manual-trigger tool handlers the loops registered. Spread
 *  this into your `createToolDispatcher({ ...getLoopTools(), myTool })` when
 *  the extension also hand-writes tools (the SDK dispatcher is
 *  last-call-wins, so a single merged registration is required). */
export function getLoopTools(): Record<string, ToolHandler> {
  return { ...loopToolHandlers };
}

/** @internal test-only — clear the loop registry + latches + tool map. */
export function __resetLoopsForTests(): void {
  registry.clear();
  assignmentHandlerInstalled = false;
  for (const k of Object.keys(loopToolHandlers)) delete loopToolHandlers[k];
}

/** @internal test-only — read a registered loop handle. */
export function _getRegisteredLoop(id: string): RegisteredLoop | undefined {
  return registry.get(id);
}

// ── defineLoop ──────────────────────────────────────────────────────

export function defineLoop<Input = unknown, Outcome = unknown>(
  def: LoopDefinition<Input, Outcome>,
): void {
  if (registry.has(def.id)) {
    throw new Error(
      `[@ezcorp/sdk] defineLoop: duplicate loop id "${def.id}" in this extension`,
    );
  }
  const contract = resolveContract<Input>(def.contract);
  const store: LoopRunStore<Outcome> = storeFactory
    ? storeFactory<Outcome>(def.id, contract as ResolvedContract)
    : createLoopRunStore<Outcome>(def.id, contract as ResolvedContract);

  const reg: RegisteredLoop = {
    id: def.id,
    contract: contract as ResolvedContract,
    store: store as LoopRunStore,
    def: def as LoopDefinition,
  };
  registry.set(def.id, reg);

  // Phase 3 hook — wire the optional dashboard (artifact mirror + page).
  wireLog(reg);

  const triggers = Array.isArray(def.trigger) ? def.trigger : [def.trigger];
  for (const trigger of triggers) {
    wireTrigger(reg, trigger);
  }

  // Deferred loops need the shared inbound-event handler installed once.
  ensureAssignmentHandler();
}

// ── Trigger wiring ──────────────────────────────────────────────────

function wireTrigger(reg: RegisteredLoop, trigger: LoopTrigger): void {
  switch (trigger.kind) {
    case "cron": {
      const schedule = new Schedule();
      schedule.on(trigger.cron, async (ctx: ScheduleHandlerContext) => {
        await runFire(reg, trigger, {
          fireId: ctx.fireId,
          firedAt: ctx.firedAt,
          catchUp: ctx.catchUp,
          input: ctx,
        });
      });
      break;
    }
    case "event": {
      registerEventHandler(trigger.event, async (payload) => {
        if (trigger.filter && !trigger.filter(payload)) {
          // Pre-gate decline → skip (logged, not an error). We still run
          // the fire so the skip is recorded uniformly.
          await runFire(reg, trigger, {
            fireId: cryptoId(),
            firedAt: new Date().toISOString(),
            catchUp: false,
            input: payload,
            preSkip: "filter_rejected",
          });
          return;
        }
        await runFire(reg, trigger, {
          fireId: cryptoId(),
          firedAt: new Date().toISOString(),
          catchUp: false,
          input: payload,
        });
      });
      break;
    }
    case "manual": {
      if (trigger.tool) {
        const handler: ToolHandler = async (
          args: Record<string, unknown>,
          ctx?: ToolHandlerContext,
        ) => {
          const result = await runFire(reg, trigger, {
            fireId: cryptoId(),
            firedAt: new Date().toISOString(),
            catchUp: false,
            input: args,
            toolCtx: ctx,
          });
          if (result.kind === "skip") {
            return toolResult(
              JSON.stringify({ loop: reg.id, skipped: true, reason: result.reason }),
            );
          }
          if (result.kind === "error") {
            return toolError(`${reg.id} failed: ${result.detail}`);
          }
          return toolResult(
            JSON.stringify({ loop: reg.id, runId: result.runId, status: result.status }),
          );
        };
        // Loud-fail on a manual-tool name collision. Because the SDK
        // dispatcher is last-call-wins, two loops (or a loop + a
        // hand-written tool of the same name) would otherwise SILENTLY
        // clobber each other — the DX footgun. Throwing here turns it into
        // an install-time crash with an actionable message.
        if (Object.hasOwn(loopToolHandlers, trigger.tool)) {
          throw new Error(
            `[@ezcorp/sdk] defineLoop: manual tool "${trigger.tool}" is already registered by another loop in this extension — give each loop's manual trigger a unique \`tool\` name`,
          );
        }
        // Accumulate into the shared loop-tool map and re-register the
        // MERGED set. `createToolDispatcher` replaces the `tools/call`
        // handler wholesale (last-call-wins), so registering the full
        // accumulated map each time keeps every loop's manual tool live.
        // An extension that ALSO hand-writes tools spreads `getLoopTools()`
        // into its own single `createToolDispatcher({ ...getLoopTools(),
        // ...ownTools })` call (see docs/extensions/loops.md).
        loopToolHandlers[trigger.tool] = handler;
        createToolDispatcher({ ...loopToolHandlers });
      }
      // `pageAction` triggers are wired through `log.dashboard.rowActions`
      // in Phase 3; a bare manual pageAction with no tool is a no-op here.
      break;
    }
  }
}

// ── Fire execution ──────────────────────────────────────────────────

interface FireMeta {
  fireId: string;
  firedAt: string;
  catchUp: boolean;
  input: unknown;
  /** When set, the trigger pre-gate already declined; short-circuit to a
   *  skip without invoking `act`. */
  preSkip?: string;
  toolCtx?: ToolHandlerContext;
}

type FireResult =
  | { kind: "skip"; reason: string }
  | { kind: "terminal"; runId: string; status: string }
  | { kind: "deferred"; runId: string; status: string }
  | { kind: "error"; detail: string };

/**
 * Execute one fire: resolve settings, build the act context, run `act`,
 * persist the run + advance the state machine, and apply failure policy.
 * Fail-soft — a thrown `act` is classified, never re-thrown to the host
 * (the listener/cron contract is fire-and-forget).
 */
async function runFire(
  reg: RegisteredLoop,
  trigger: LoopTrigger,
  meta: FireMeta,
): Promise<FireResult> {
  // Auto-disable latch: a disabled loop skips every fire (it stays
  // registered so a settings flip / restart can re-enable it).
  const initialMeta = await reg.store.getMeta();
  if (initialMeta.disabled) {
    return { kind: "skip", reason: "auto_disabled" };
  }
  if (meta.preSkip) {
    return { kind: "skip", reason: meta.preSkip };
  }

  const settings = await settingsResolverImpl();
  const logLines: string[] = [];
  const ctx: LoopActContext = {
    fire: {
      id: meta.fireId,
      firedAt: meta.firedAt,
      trigger,
      catchUp: meta.catchUp,
    },
    input: meta.input,
    settings,
    llm: llmFactory(),
    recentMessages: async (conversationId: string, n = 20) => {
      const { messages } = await messagesResolverImpl(conversationId);
      return messages.slice(-Math.max(0, n));
    },
    formatMessages,
    spawn: spawnImpl,
    log: (msg, level = "info") => {
      logLines.push(`[${level}] ${msg}`);
    },
  };

  let result: ActResult;
  try {
    result = await reg.def.act(ctx);
  } catch (err) {
    return handleFailure(reg, err);
  }

  // Any act that succeeded resets the consecutive-error counter.
  await resetErrorsIfNeeded(reg, initialMeta);

  const invalid = validateActResult(result, reg.contract);
  if (invalid) {
    return handleFailure(reg, new Error(invalid));
  }

  if (result.kind === "skip") {
    return { kind: "skip", reason: result.reason };
  }

  if (result.kind === "terminal") {
    const note = logLines[0];
    const key = idemKey(reg, meta.input);
    // Capture loops resolve in one fire — claim the run already at the
    // terminal status carrying the outcome (no redundant transition, so
    // the event log has a single entry).
    const { run } = await reg.store.claim({
      id: meta.fireId,
      loopId: reg.id,
      status: result.status,
      input: meta.input,
      outcome: result.outcome,
      ...(key ? { idempotencyKey: key } : {}),
      ...(note ? { note } : {}),
    });
    await afterTerminal(reg, run, result.outcome);
    return { kind: "terminal", runId: run.id, status: result.status };
  }

  // Deferred: open a non-terminal run keyed by the spawned runId.
  const note = logLines[0];
  const deferredKey = idemKey(reg, meta.input);
  const { run } = await reg.store.claim({
    id: result.runId,
    loopId: reg.id,
    status: result.status,
    input: meta.input,
    ...(deferredKey ? { idempotencyKey: deferredKey } : {}),
    externalRunId: result.runId,
    ...(result.assignmentId ? { externalAssignmentId: result.assignmentId } : {}),
    ...(result.taskId ? { externalTaskId: result.taskId } : {}),
    ...(result.subConversationId ? { subConversationId: result.subConversationId } : {}),
    ...(note ? { note } : {}),
  });
  await reg.pushDashboard?.();
  return { kind: "deferred", runId: run.id, status: result.status };
}

function idemKey(reg: RegisteredLoop, input: unknown): string | undefined {
  return reg.contract.idempotencyKey?.(input);
}

/** Reset the consecutive-error counter after a non-throwing act. Only
 *  writes when it was non-zero (avoid needless KV churn). */
async function resetErrorsIfNeeded(
  reg: RegisteredLoop,
  current: { consecutiveErrors: number; disabled: boolean },
): Promise<void> {
  if (current.consecutiveErrors !== 0) {
    await reg.store.setMeta({ consecutiveErrors: 0, disabled: current.disabled });
  }
}

/** Apply the failure policy: classify, increment the consecutive counter,
 *  and auto-disable + notify when the threshold trips. Returns an error
 *  FireResult. */
async function handleFailure(
  reg: RegisteredLoop,
  err: unknown,
): Promise<FireResult> {
  const meta = await reg.store.getMeta();
  const decision = classifyFailure(err, meta.consecutiveErrors, reg.contract);
  const nextMeta = {
    consecutiveErrors: decision.consecutiveErrors,
    disabled: meta.disabled || decision.shouldDisable,
  };
  await reg.store.setMeta(nextMeta);
  if (decision.shouldDisable && reg.contract.onAutoDisable) {
    try {
      await reg.contract.onAutoDisable(
        autoDisableContext(reg.id, decision, err),
      );
    } catch {
      // Notification failure must not mask the original error.
    }
  }
  return { kind: "error", detail: err instanceof Error ? err.message : String(err) };
}

/** Write the artifact mirror + push the dashboard after a terminal
 *  outcome. Delegates to the `loop-log` module (Phase 3); a loop with no
 *  `log` block is a no-op. */
async function afterTerminal(
  reg: RegisteredLoop,
  run: LoopRunState,
  outcome: unknown,
): Promise<void> {
  await runTerminalLog(reg, run, outcome);
}

// ── Deferred completion: task:assignment_update ─────────────────────

function ensureAssignmentHandler(): void {
  if (assignmentHandlerInstalled) return;
  // Only install when at least one registered loop can go deferred. We
  // install unconditionally (cheap) — a loop with no open deferred run
  // simply never matches.
  assignmentHandlerInstalled = true;
  registerEventHandler("task:assignment_update", async (payload) => {
    await dispatchAssignmentUpdate(payload as TaskAssignmentUpdateEvent);
  });
}

/** Fan an inbound assignment update to whichever registered loop owns the
 *  matching OPEN run, then transition it. Idempotent — a late/duplicate
 *  event for a closed run is a no-op. */
export async function dispatchAssignmentUpdate(
  evt: TaskAssignmentUpdateEvent,
): Promise<void> {
  const a = evt.assignment;
  for (const reg of registry.values()) {
    const runs = await reg.store.list();
    const match = runs.find(
      (r) =>
        (!!a.agentRunId && r.id === a.agentRunId) ||
        (!!a.agentRunId && r.externalRunId === a.agentRunId) ||
        r.externalAssignmentId === a.id ||
        r.externalTaskId === evt.taskId,
    );
    if (!match) continue;
    const nextStatus = mapAssignmentStatus(a.status, reg.contract);
    const updated = await reg.store.transition(match.id, {
      status: nextStatus,
      ...(a.resultPreview ? { note: a.resultPreview } : {}),
    });
    if (updated && isTerminalStatus(nextStatus, reg.contract)) {
      await afterTerminal(reg, updated, updated.outcome);
    } else {
      await reg.pushDashboard?.();
    }
    // An assignment maps to exactly one loop's run; stop after the first
    // match.
    return;
  }
}

/**
 * Map a host assignment status onto the contract vocabulary.
 *   - A status already in the vocabulary passes through verbatim (the
 *     common case — contracts declare `completed`/`failed`/`cancelled`).
 *   - A terminal-ish host status (`failed`/`cancelled`/`completed`) that
 *     isn't declared falls back to the contract's first terminal state.
 *   - Anything else keeps the run OPEN at the first non-terminal state.
 * `contract.terminal` and the non-terminal set are both non-empty by
 * construction (`resolveContract` guarantees ≥1 state and a terminal
 * subset), so the lookups always resolve. Pure.
 */
function mapAssignmentStatus(
  status: string,
  contract: ResolvedContract,
): string {
  if (contract.states.includes(status)) return status;
  if (status === "failed" || status === "cancelled" || status === "completed") {
    return contract.terminal[0]!;
  }
  // Reached only for an OPEN run (dispatchAssignmentUpdate matches live
  // runs only), so the contract always has a non-terminal state here.
  return contract.states.find((s) => !contract.terminal.includes(s))!;
}

function isTerminalStatus(status: string, contract: ResolvedContract): boolean {
  return contract.terminal.includes(status);
}

// Re-export the registered-loop shape for the log module.
export type { RegisteredLoop };
export { definePage, pushPage };

// ── small utils ─────────────────────────────────────────────────────

/** Fresh fire id. `crypto.randomUUID` is always present in the Bun
 *  extension runtime. */
function cryptoId(): string {
  return crypto.randomUUID();
}
