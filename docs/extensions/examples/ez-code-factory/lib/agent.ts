// ── Agent invocation layer — native spawn-assignment dispatch ────────
//
// Decision #2 (locked): pipeline agents are EZCorp-native ONLY. Every per-step
// agent turn runs as a `ezcorp/spawn-assignment` sub-agent whose LLM calls go
// through the platform's host-brokered provider layer — NO external coding-agent
// CLI, ever. Upstream's 6-adapter agent layer is deleted; its verbatim per-step
// PROMPTS are kept (see prompts.ts + the step modules).
//
// The host-completion bridge (spawn → await the terminal
// `task:assignment_update` carrying the schema-validated `structuredResult`) is
// an integration seam that cannot run in a unit test without a live host, so —
// per the M1 brief — it is wrapped behind the injectable `AgentDispatcher`
// interface and its production wiring (spawn / subscribe / delay) is injected,
// letting tests exercise every branch deterministically with fakes.
//
// M1 runs every invocation COLD (no durable session reuse — upstream's
// Sessions==nil path). Durable reviewer/fixer sessions land in a later milestone.

import { spawnAssignment, registerEventHandler } from "@ezcorp/sdk/runtime";
import type { SpawnAssignmentInput, SpawnAssignmentHandle } from "@ezcorp/sdk/runtime";
import { worktreeSteeringPreamble } from "./prompts";

/** Which durable-session role a turn plays (labels the sub-conversation title;
 *  M1 does not yet reuse sessions, so it is cosmetic). */
export type SessionRole = "reviewer" | "fixer" | "generic";

export interface DispatchOptions {
  /** Role label for the spawned sub-conversation title. */
  role: SessionRole;
  /** The fully-assembled step prompt (exec-context / round-history / intent
   *  sections already appended by the step). Worktree steering is prepended
   *  here, mirroring upstream's WithSteering wrapper. */
  prompt: string;
  /** Absolute worktree dir the agent must operate in. */
  cwd: string;
  /** Object JSON schema the agent's final answer must satisfy. */
  jsonSchema?: Record<string, unknown>;
  /** Per-step agent config name (a settings knob). Omit for the deployment default. */
  agentName?: string;
}

export interface DispatchResult {
  /** Host-validated structured output, or null when the agent produced none. */
  output: unknown | null;
  /** The agent's final text (used as a fallback when `output` is null). */
  text: string;
}

/** The single seam every pipeline step drives an agent through. */
export interface AgentDispatcher {
  dispatch(opts: DispatchOptions): Promise<DispatchResult>;
}

// ── Terminal-update shaping (pure) ──────────────────────────────────

/** The subset of a `task:assignment_update` payload the dispatcher consumes. */
export interface AssignmentUpdate {
  assignment: { id: string; status: string; resultPreview?: string };
  resultFull?: string;
  structuredResult?: unknown;
  structuredResultError?: string;
}

/** Terminal statuses (mirrors the orchestration bridge). */
export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Shape a TERMINAL, COMPLETED update into a DispatchResult. `structuredResult`
 * (host-validated) wins; otherwise `output` is null and the caller falls back to
 * `text`. A `structuredResultError` (schema violation / over-cap) leaves output
 * null but still surfaces the raw text. Pure.
 */
export function extractStructuredOutput(update: AssignmentUpdate): DispatchResult {
  const text = update.resultFull ?? update.assignment.resultPreview ?? "";
  const output = update.structuredResult !== undefined ? update.structuredResult : null;
  return { output, text };
}

// ── Spawn-input assembly (pure) ─────────────────────────────────────

/**
 * Build the `spawnAssignment` input for a dispatch. The task body is the
 * worktree-steering preamble + a concrete "operate on this worktree" line +
 * the step prompt; the schema is forwarded as `outputSchema` so the host
 * validates the agent's final answer. Pure.
 */
export function buildSpawnInput(opts: DispatchOptions, evidenceDir: string): SpawnAssignmentInput {
  const task =
    worktreeSteeringPreamble(evidenceDir) +
    `You are operating on the git worktree at: ${opts.cwd}\n` +
    opts.prompt;
  const input: SpawnAssignmentInput = {
    task,
    title: `ez-code-factory: ${opts.role}`,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.jsonSchema ? { outputSchema: opts.jsonSchema } : {}),
  };
  // A spawn requires one of agentConfigId / agentName. When no per-step agent is
  // configured, name the deployment's default agent by convention.
  if (!input.agentName) input.agentName = "default";
  return input;
}

// ── Production dispatcher (injectable wiring) ───────────────────────

/** Dispatch a spawn and return its handle. Default: the SDK `spawnAssignment`. */
export type SpawnFn = (input: SpawnAssignmentInput) => Promise<SpawnAssignmentHandle>;
/** Subscribe once to terminal-carrying assignment updates. Default: the SDK
 *  `registerEventHandler("task:assignment_update", …)`. */
export type SubscribeFn = (handler: (update: AssignmentUpdate) => void) => void;
/** Sleep helper (injectable so the timeout race is deterministic in tests). The
 *  optional `signal` lets the caller cancel a still-pending delay (clearing its
 *  timer) once the terminal update has already won the race. */
export type DelayFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface SpawnDispatcherDeps {
  /** Absolute evidence dir named in the steering preamble. */
  evidenceDir: string;
  /** Spawn seam (default: SDK spawnAssignment). */
  spawn?: SpawnFn;
  /** Subscription seam (default: SDK registerEventHandler). */
  subscribe?: SubscribeFn;
  /** Delay seam (default: real setTimeout). */
  delay?: DelayFn;
  /** Max wall-clock ms to await a terminal update (default 10 min). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const defaultSpawn: SpawnFn = (input) => spawnAssignment(input);
const defaultSubscribe: SubscribeFn = (handler) =>
  registerEventHandler("task:assignment_update", (payload) => {
    handler(payload as AssignmentUpdate);
  });
const defaultDelay: DelayFn = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Clear the pending timer if the caller aborts (terminal update won the
    // race), so a resolved dispatch never leaves a 10-minute timeout dangling
    // on the event loop.
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });

/**
 * Build the production dispatcher. It registers ONE `task:assignment_update`
 * handler (lazily, on first dispatch) that routes terminal updates to pending
 * dispatches by assignment id — the orchestration bridge pattern, so concurrent
 * runs on different branches don't clobber each other's single-slot handler. A
 * `failed` terminal or a timeout rejects (fail closed: the step errors and the
 * run fails rather than proceeding on empty findings).
 */
export function makeSpawnDispatcher(deps: SpawnDispatcherDeps): AgentDispatcher {
  const spawn = deps.spawn ?? defaultSpawn;
  const subscribe = deps.subscribe ?? defaultSubscribe;
  const delay = deps.delay ?? defaultDelay;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pending = new Map<string, (update: AssignmentUpdate) => void>();
  let subscribed = false;

  const ensureSubscribed = (): void => {
    if (subscribed) return;
    subscribed = true;
    subscribe((update) => {
      const id = update.assignment?.id;
      if (typeof id !== "string") return;
      if (!isTerminalStatus(update.assignment.status)) return;
      const resolver = pending.get(id);
      if (resolver) resolver(update);
    });
  };

  return {
    async dispatch(opts) {
      ensureSubscribed();
      const input = buildSpawnInput(opts, deps.evidenceDir);
      const handle = await spawn(input);
      const assignmentId = handle.assignmentId;

      const terminal = new Promise<AssignmentUpdate>((resolve) => {
        pending.set(assignmentId, resolve);
      });
      // Cancels the timeout timer as soon as a terminal update wins the race (or
      // the dispatch throws) — see defaultDelay's abort handling.
      const timeoutAbort = new AbortController();
      try {
        const outcome = await Promise.race([
          terminal.then((update) => ({ kind: "update" as const, update })),
          delay(timeoutMs, timeoutAbort.signal).then(() => ({ kind: "timeout" as const })),
        ]);
        if (outcome.kind === "timeout") {
          throw new Error(`agent dispatch timed out after ${timeoutMs}ms (${opts.role})`);
        }
        const { update } = outcome;
        if (update.assignment.status === "failed") {
          const detail = update.resultFull ?? update.assignment.resultPreview ?? "no detail";
          throw new Error(`agent run failed (${opts.role}): ${detail}`);
        }
        return extractStructuredOutput(update);
      } finally {
        timeoutAbort.abort();
        pending.delete(assignmentId);
      }
    },
  };
}
