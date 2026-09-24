import type { ApplyDiagnostic, ApplyReceipt, CommandResult, IncusImageBootstrapPlan, IncusSetupPlan, OutcomeClass, SetupStep, StepObservation } from "./model";
import { SETUP_SCHEMA_VERSION, assertSetupPlanDigest, digest, isSubset } from "./model";
import type { RemoteRunner } from "./inspect";

function parseObserved(step: SetupStep, result: CommandResult): StepObservation {
  if (step.inspect.notFoundExitCodes.includes(result.exitCode)) return "absent";
  if (result.exitCode !== 0) return "drift";
  const trimmed = result.stdout.trim();
  if (step.inspect.emptyAsAbsent && trimmed === "") return "absent";
  let actual: unknown = trimmed;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { actual = JSON.parse(trimmed); } catch { return "drift"; }
  }
  return isSubset(step.inspect.expected, actual) ? "match" : "drift";
}

export function classifyApplyResult(result: CommandResult): OutcomeClass {
  if (result.timedOut) return "reconcile";
  if (result.exitCode === 0) return "succeeded";
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut || /connection (?:closed|reset)|broken pipe|timed out|timeout|unexpected eof/.test(diagnostic)) return "reconcile";
  if (/already exists|conflict|operation.*(?:pending|running|in progress)|database is locked/.test(diagnostic)) return "reconcile";
  if (/temporar(?:y|ily)|try again|server is busy|too many requests/.test(diagnostic)) return "retryable";
  return "review_required";
}

/** Only a reviewed project config key can be named; never return runner text. */
function safeConfigDiagnostic(step: SetupStep, result: CommandResult): ApplyDiagnostic | undefined {
  if (step.id !== "restricted-project" || step.resource !== "project") return undefined;
  const output = `${result.stdout}\n${result.stderr}`;
  if (Buffer.byteLength(output) > 16 * 1024) return undefined;
  const match = /Invalid project configuration key "([a-z][a-z0-9.-]{0,127})"/.exec(output);
  const key = match?.[1];
  if (!key || !step.apply.argv.some((arg, index) => arg === "--config" && step.apply.argv[index + 1]?.startsWith(`${key}=`))) {
    return undefined;
  }
  return { code: "UNSUPPORTED_CONFIG_KEY", rejectedKey: key };
}

export async function inspectStep(step: SetupStep, runner: RemoteRunner): Promise<StepObservation> {
  return parseObserved(step, await runner(step.inspect.argv));
}

export async function applySetupPlan(plan: IncusSetupPlan, runner: RemoteRunner, options: { execute?: boolean; approvedPlanDigest?: string; preflightPlan?: IncusSetupPlan } = {}): Promise<ApplyReceipt> {
  if ("purpose" in plan) throw new Error("image bootstrap plan requires its own apply command");
  return applyPlan(plan, runner, options);
}

export async function applyImageBootstrapPlan(plan: IncusImageBootstrapPlan, runner: RemoteRunner, options: { execute?: boolean; approvedPlanDigest?: string; preflightPlan: IncusImageBootstrapPlan }): Promise<ApplyReceipt> {
  if (plan.purpose !== "image_bootstrap" || options.preflightPlan.purpose !== "image_bootstrap") throw new Error("image bootstrap purpose is required");
  assertSetupPlanDigest(plan);
  assertSetupPlanDigest(options.preflightPlan);
  if (plan.baselineFingerprint !== options.preflightPlan.baselineFingerprint || digest(plan.steps) !== digest(options.preflightPlan.steps)) {
    return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "blocked", blockedReasons: ["bootstrap_preflight_drift"], steps: [] };
  }
  if (digest(plan.targetPresence) !== digest(options.preflightPlan.targetPresence)) {
    return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "blocked", blockedReasons: ["bootstrap_target_ownership_changed"], steps: [] };
  }
  return applyPlan(plan, runner, {
    ...options,
    expectedBefore: { "storage-pool": plan.targetPresence.storage ? "match" : "absent", "managed-network": plan.targetPresence.network ? "match" : "absent" },
  });
}

async function applyPlan(plan: IncusSetupPlan, runner: RemoteRunner, options: { execute?: boolean; approvedPlanDigest?: string; preflightPlan?: IncusSetupPlan; expectedBefore?: Record<string, StepObservation> } = {}): Promise<ApplyReceipt> {
  assertSetupPlanDigest(plan);
  if (options.preflightPlan) {
    assertSetupPlanDigest(options.preflightPlan);
    if (options.preflightPlan.recipeDigest !== plan.recipeDigest || options.preflightPlan.setupId !== plan.setupId) throw new Error("current preflight does not match the approved setup");
  }
  const blockedReasons = [...new Set([...plan.blockedReasons, ...(options.preflightPlan?.blockedReasons ?? [])])].sort();
  if (plan.status !== "ready" || options.preflightPlan?.status === "blocked") return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "blocked", blockedReasons, steps: [] };
  if (options.execute && options.approvedPlanDigest !== plan.planDigest) throw new Error("execution requires the exact approved plan digest");
  const receipts: ApplyReceipt["steps"] = [];
  for (const step of plan.steps) {
    const before = await inspectStep(step, runner);
    if (options.expectedBefore?.[step.id] !== undefined && before !== options.expectedBefore[step.id]) {
      receipts.push({ id: step.id, before, action: "stopped", outcome: "review_required" });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "review_required", steps: receipts };
    }
    if (before === "match") { receipts.push({ id: step.id, before, action: "skipped", outcome: "succeeded" }); continue; }
    if (before === "drift") { receipts.push({ id: step.id, before, action: "stopped", outcome: "review_required" }); return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "review_required", steps: receipts }; }
    if (!options.execute) { receipts.push({ id: step.id, before, action: "planned", outcome: "succeeded" }); continue; }
    let result: CommandResult;
    try { result = await runner(step.apply.argv, step.apply.stdin); }
    catch {
      receipts.push({ id: step.id, before, action: "stopped", outcome: "reconcile" });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: "reconcile_required", steps: receipts };
    }
    const outcome = classifyApplyResult(result);
    if (outcome !== "succeeded") {
      const diagnostic = outcome === "review_required" ? safeConfigDiagnostic(step, result) : undefined;
      receipts.push({ id: step.id, before, action: "stopped", outcome, exitCode: result.exitCode,
        ...(diagnostic ? { diagnostic } : {}) });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: outcome === "review_required" ? "review_required" : "reconcile_required", steps: receipts };
    }
    let after: StepObservation;
    try { after = await inspectStep(step, runner); }
    catch {
      receipts.push({ id: step.id, before, action: "stopped", outcome: "reconcile", exitCode: result.exitCode });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: "reconcile_required", steps: receipts };
    }
    if (after !== "match") {
      receipts.push({ id: step.id, before, action: "stopped", outcome: "reconcile", exitCode: result.exitCode });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: "reconcile_required", steps: receipts };
    }
    receipts.push({ id: step.id, before, action: "executed", outcome: "succeeded", exitCode: result.exitCode });
  }
  return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: options.execute ? "applied" : "dry_run", steps: receipts };
}
