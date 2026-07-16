// ── Chat-entry tools — run / status / respond (M5 deliverable A) ─────
//
// The /no-mistakes-skill equivalent as PURE-EXTENSION LLM-callable tools with
// the contract enforced IN CODE (locked decision §4). These orchestrators are a
// THIN, VALIDATED surface over the M0/M1/M2 backend — they reuse
// runGateLifecycle / resumeGateLifecycle / respondToGate / parseRespondPayload
// (the single validator) rather than forking any of it, and route every gate-
// findings result through chat-contract.ts's two structural guards:
//   - formatGateRelay      → verbatim ask-user relay (must stop + relay)
//   - enforceNamedApproval → no blanket approval (approve/fix needs finding ids)
//
// Every backend touch is an injected seam (shell runner, run store, trigger /
// resume lifecycle, intent inference), so the whole module is unit-testable with
// fakes — no live host, no real git. index.ts owns the production wiring.

import { PIPELINE_STEPS, type PipelineStep } from "./config";
import {
  parseRespondPayload,
  type Findings,
  type ParsedRespond,
  type PushReceived,
  type RunLifecycleResult,
  type RunStatus,
  type RunStore,
  type StepStatus,
} from "./runs";
import type { ShellRunner } from "./shell";
import {
  enforceRespondContract,
  formatGateRelay,
  type GateRelay,
} from "./chat-contract";
import type { InferredIntent } from "./intent-infer";

/** All-zeros SHA — the force-push anchor for a branch the gate has never seen. */
const ZERO_SHA = "0".repeat(40);
/** Max accepted explicit-intent length (defence in depth — mirrors runs.ts
 *  MAX_INTENT_LEN; the prompt layer also sanitizes + caps). */
const MAX_INTENT_LEN = 4000;

/** Discriminated tool outcome — index.ts maps `ok` to toolResult(JSON) and the
 *  error string to toolError. */
export type ChatToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** The gate state one tool call reports: run status + the parked step's relay. */
export interface GateStatus {
  runId: string;
  status: RunStatus;
  branch: string;
  headSha: string;
  intent: string | null;
  intentSource: string | null;
  prUrl: string | null;
  /** The step the run is parked at (awaiting_approval/fix_review), or null. */
  parkedStep: PipelineStep | null;
  parkedStepStatus: StepStatus | null;
  /** The parked step's findings split into ask-user (relay verbatim + stop) vs
   *  agent-discretion, or null when nothing is parked. */
  relay: GateRelay | null;
  /** Every recorded step's status, in pipeline order. */
  steps: { step: PipelineStep; status: StepStatus }[];
}

/** Everything the three tools need. All backend access is injected. */
export interface ChatToolDeps {
  projectRoot: string;
  gateDir: string;
  repoId: string;
  /** Default branch the diff is computed against (intent-inference relevance). */
  defaultBranch: string;
  run: ShellRunner;
  store: RunStore;
  /** Start a run for a constructed push (production: runGateLifecycle). */
  triggerRun: (push: PushReceived) => Promise<RunLifecycleResult>;
  /** Resume a parked run with a validated respond (production: resumeGateLifecycle
   *  + the respond runner). Null when the run/worktree could not resume. */
  resumeRun: (runId: string, respond: ParsedRespond) => Promise<{ status: RunStatus; parked: boolean } | null>;
  /** Infer intent from the current conversation (production: the conversation
   *  RPC + summarizer). Null when no inference applies. */
  inferIntent: (diffFiles: string[]) => Promise<InferredIntent | null>;
  log?: (message: string) => void;
}

// ── git helpers (all behind the injected runner) ────────────────────

/** A branch name must be free of shell metacharacters + path traversal (the
 *  same shape parsePushReceived enforces on the hook path). */
function isSafeBranch(branch: string): boolean {
  if (branch === "") return false;
  if (/[^\w./\-]/.test(branch) || branch.includes("..")) return false;
  return true;
}

/** The active branch (arg override, else the project's checked-out branch). */
async function resolveBranch(deps: ChatToolDeps, arg: unknown): Promise<string | null> {
  if (typeof arg === "string" && arg.trim() !== "") {
    const b = arg.trim();
    return isSafeBranch(b) ? b : null;
  }
  const res = await deps.run(
    ["git", "-C", deps.projectRoot, "symbolic-ref", "--quiet", "--short", "HEAD"],
    deps.projectRoot,
  );
  if (res.exitCode !== 0) return null;
  const b = res.stdout.trim();
  return isSafeBranch(b) ? b : null;
}

/** `git rev-parse --verify <rev>` in `cwd`, or null on failure / non-hex. */
async function revParse(deps: ChatToolDeps, cwd: string, rev: string): Promise<string | null> {
  const res = await deps.run(["git", "-C", cwd, "rev-parse", "--verify", `${rev}^{commit}`], cwd);
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

/** Repo-relative files the change touches vs the default branch (best-effort —
 *  an empty list disables the intent-inference relevance gate). */
async function changedFiles(deps: ChatToolDeps, branch: string): Promise<string[]> {
  const res = await deps.run(
    ["git", "-C", deps.projectRoot, "diff", "--name-only", `${deps.defaultBranch}...${branch}`],
    deps.projectRoot,
  );
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// ── shared gate-status builder ──────────────────────────────────────

/** Read a run + its step results into a GateStatus, routing the parked step's
 *  findings through the verbatim-relay structural split. Null when unknown. */
export async function buildGateStatus(store: RunStore, runId: string): Promise<GateStatus | null> {
  const rec = await store.getRun(runId);
  if (!rec) return null;
  const steps: { step: PipelineStep; status: StepStatus }[] = [];
  let parkedStep: PipelineStep | null = null;
  let parkedStepStatus: StepStatus | null = null;
  let parkedFindings: Findings | null = null;
  for (const step of PIPELINE_STEPS) {
    const sr = await store.getStepResult(runId, step);
    if (!sr) continue;
    steps.push({ step, status: sr.status });
    if (parkedStep === null && (sr.status === "awaiting_approval" || sr.status === "fix_review")) {
      parkedStep = step;
      parkedStepStatus = sr.status;
      parkedFindings = sr.findings;
    }
  }
  return {
    runId: rec.id,
    status: rec.status,
    branch: rec.branch,
    headSha: rec.headSha,
    intent: rec.intent,
    intentSource: rec.intentSource,
    prUrl: rec.prUrl ?? null,
    parkedStep,
    parkedStepStatus,
    relay: parkedFindings ? formatGateRelay(parkedFindings) : null,
    steps,
  };
}

/** Serialize a GateStatus into the tool result payload. When the gate is parked
 *  on an ask-user finding, the stop directive + verbatim findings ride at the
 *  TOP so the driving LLM cannot miss them. */
function statusData(status: GateStatus): Record<string, unknown> {
  const base: Record<string, unknown> = {
    runId: status.runId,
    status: status.status,
    branch: status.branch,
    headSha: status.headSha,
    intent: status.intent,
    intentSource: status.intentSource,
    prUrl: status.prUrl,
    parkedStep: status.parkedStep,
    steps: status.steps,
  };
  if (status.relay && status.relay.stop) {
    // Lead with the machine-enforced relay contract.
    return {
      mustRelayVerbatim: true,
      relayDirective: status.relay.directive,
      askUserFindings: status.relay.askUser,
      agentDiscretionFindings: status.relay.agentDiscretion,
      ...base,
    };
  }
  if (status.relay) {
    base.askUserFindings = status.relay.askUser; // empty
    base.agentDiscretionFindings = status.relay.agentDiscretion;
    base.mustRelayVerbatim = false;
  }
  return base;
}

// ── code_factory_run ────────────────────────────────────────────────

/**
 * Trigger a gate run for the active project's current branch. Resolves the
 * branch + head, lands the objects in the bare gate repo hook-free (a fetch by
 * the gate repo does NOT fire post-receive, so there is no double-run with the
 * push path), resolves the intent (explicit arg = authoritative; otherwise
 * inferred from the current conversation = HINT), and drives the SAME
 * runGateLifecycle the hook path uses. Returns the resulting gate status —
 * including the verbatim ask-user relay when the run parks immediately.
 */
export async function runChatTool(
  args: { intent?: unknown; branch?: unknown },
  deps: ChatToolDeps,
): Promise<ChatToolOutcome> {
  const log = deps.log ?? (() => {});
  const branch = await resolveBranch(deps, args.branch);
  if (!branch) {
    return { ok: false, error: "could not resolve a safe target branch (checkout a branch or pass `branch`)" };
  }
  const newSha = await revParse(deps, deps.projectRoot, branch);
  if (!newSha) {
    return { ok: false, error: `branch '${branch}' has no resolvable commit in the project repo` };
  }
  // The gate's PRIOR tip for this branch — the force-push safety anchor. Captured
  // BEFORE the fetch so it reflects the last-observed remote head (like oldrev).
  const oldSha = (await revParse(deps, deps.gateDir, `refs/heads/${branch}`)) ?? ZERO_SHA;

  // Resolve intent: explicit wins (authoritative); else infer from the current
  // conversation (a low-confidence HINT). Diff files gate the inference's
  // relevance. Inference failure is a normal "no intent" outcome, never fatal.
  let intent: string | null = null;
  let intentSource: string | null = null;
  const explicit = typeof args.intent === "string" ? args.intent.trim() : "";
  if (explicit !== "") {
    intent = explicit.length > MAX_INTENT_LEN ? explicit.slice(0, MAX_INTENT_LEN) : explicit;
    intentSource = "agent";
  } else {
    const diffFiles = await changedFiles(deps, branch);
    const inferred = await deps.inferIntent(diffFiles);
    if (inferred) {
      intent = inferred.summary.length > MAX_INTENT_LEN ? inferred.summary.slice(0, MAX_INTENT_LEN) : inferred.summary;
      intentSource = inferred.source;
      log(`attached inferred intent (source=${inferred.source}, score=${inferred.score.toFixed(2)})`);
    }
  }

  // Land the objects in the gate repo hook-free (force-update the gate branch to
  // the project's tip). A fetch BY the bare repo runs no receive hooks.
  const fetched = await deps.run(
    ["git", "-C", deps.gateDir, "fetch", deps.projectRoot, `+refs/heads/${branch}:refs/heads/${branch}`],
    deps.gateDir,
  );
  if (fetched.exitCode !== 0) {
    return {
      ok: false,
      error:
        `failed to stage '${branch}' into the gate repo (exit ${fetched.exitCode}): ` +
        `${fetched.stderr.trim() || fetched.stdout.trim() || "is the gate initialized? run init_gate first"}`,
    };
  }

  const push: PushReceived = {
    repoId: deps.repoId,
    branch,
    ref: `refs/heads/${branch}`,
    newSha,
    oldSha,
    intent,
    intentSource,
  };
  const result = await deps.triggerRun(push);
  const status = await buildGateStatus(deps.store, result.runId);
  if (!status) {
    // The run row vanished (store race) — surface the lifecycle result directly.
    return {
      ok: result.ok || result.status === "awaiting_approval",
      data: { runId: result.runId, status: result.status, ...(result.error ? { error: result.error } : {}) },
    } as ChatToolOutcome;
  }
  return { ok: true, data: { triggered: true, ...statusData(status) } };
}

// ── code_factory_status ─────────────────────────────────────────────

/**
 * Report the current gate state / findings. With a runId → that run; without →
 * the newest run. An ask-user parked gate returns the verbatim relay wrapper +
 * stop signal (the driving LLM must relay + stop).
 */
export async function statusChatTool(
  args: { runId?: unknown },
  deps: ChatToolDeps,
): Promise<ChatToolOutcome> {
  let runId = typeof args.runId === "string" && args.runId.trim() !== "" ? args.runId.trim() : null;
  if (!runId) {
    const runs = await deps.store.listRuns();
    if (runs.length === 0) {
      return { ok: true, data: { runs: [], message: "no gate runs yet — trigger one with code_factory_run" } };
    }
    runId = runs[0]!.id; // listRuns is newest-first
  }
  const status = await buildGateStatus(deps.store, runId);
  if (!status) return { ok: false, error: `unknown run ${runId}` };
  return { ok: true, data: statusData(status) };
}

// ── code_factory_respond ────────────────────────────────────────────

/**
 * Answer a parked gate (approve/fix/skip/abort). Validates via the single M1
 * validator (parseRespondPayload), then enforces the NO-BLANKET-APPROVAL
 * contract AGAINST THE PARKED STEP'S REAL FINDINGS:
 *   - a CLEAN gate (no ask-user findings) accepts an ids-free `approve`;
 *   - an approve/fix over a gate WITH ask-user findings must name explicit
 *     findingIds (or set `consentAll:true`, which is logged + marked);
 *   - any named findingId must actually exist on the parked step (junk ids
 *     rejected — proof the agent loaded the real findings).
 * Then drives resumeGateLifecycle → respondToGate and returns the post-respond
 * gate status (which re-surfaces the verbatim relay if the run re-parks).
 */
export async function respondChatTool(
  args: {
    runId?: unknown;
    step?: unknown;
    action?: unknown;
    findingIds?: unknown;
    instructions?: unknown;
    addedFindings?: unknown;
    consentAll?: unknown;
  },
  deps: ChatToolDeps,
): Promise<ChatToolOutcome> {
  const log = deps.log ?? (() => {});
  const respond = parseRespondPayload({
    runId: args.runId,
    step: args.step,
    action: args.action,
    findingIds: args.findingIds,
    instructions: args.instructions,
    addedFindings: args.addedFindings,
  });
  if (!respond) {
    return {
      ok: false,
      error:
        "invalid respond: need runId, a known pipeline step, and action approve|fix|skip|abort " +
        "(within the finding/instruction size caps)",
    };
  }

  const rec = await deps.store.getRun(respond.runId);
  if (!rec) return { ok: false, error: `unknown run ${respond.runId}` };

  // Load the parked step's REAL findings — the contract enforces against them,
  // not against the payload alone (a missing step result → a clean, empty set).
  const stepResult = await deps.store.getStepResult(respond.runId, respond.step);
  const parkedItems = stepResult?.findings.items ?? [];
  const askUserCount = parkedItems.filter((f) => f.action === "ask-user").length;

  // CONTRACT-IN-CODE (spec §1 inv2): the SHARED no-blanket-approval chokepoint
  // — no bulk auto-approve of a gate WITH ask-user findings (a clean gate
  // approves ids-free; consentAll bypasses + is flagged), and every named id
  // must exist on the parked step. The Hub/events respond path runs the SAME
  // helper, so neither surface can bypass the locked invariant.
  const guard = enforceRespondContract(
    respond.action,
    respond.findingIds,
    args.consentAll === true,
    parkedItems,
  );
  if (!guard.ok) return { ok: false, error: guard.error! };
  // AUDIT: a standing-consent bulk clear is never silent — log it + mark it.
  if (guard.consentAllUsed) {
    log(
      `consentAll bypass: run=${respond.runId} step=${respond.step} action=${respond.action} ` +
        `cleared a gate with ${askUserCount} ask-user finding(s) WITHOUT named ids (standing consent)`,
    );
  }

  const result = await deps.resumeRun(respond.runId, respond);
  if (result === null) {
    return {
      ok: false,
      error: `run ${respond.runId} could not resume — it may not be parked at step '${respond.step}' (check code_factory_status)`,
    };
  }
  const status = await buildGateStatus(deps.store, respond.runId);
  if (!status) return { ok: false, error: `unknown run ${respond.runId}` };
  return {
    ok: true,
    data: { applied: true, action: respond.action, consentAllUsed: guard.consentAllUsed === true, ...statusData(status) },
  };
}
