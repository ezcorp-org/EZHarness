import type { ApplyReceipt, CommandResult, IncusSetupPlan, OutcomeClass, SetupStep, StepObservation } from "./model";
import { SETUP_SCHEMA_VERSION, assertSetupPlanDigest, isSubset } from "./model";
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
  if (result.exitCode === 0) return "succeeded";
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut || /connection (?:closed|reset)|broken pipe|timed out|timeout|unexpected eof/.test(diagnostic)) return "reconcile";
  if (/already exists|conflict|operation.*(?:pending|running|in progress)|database is locked/.test(diagnostic)) return "reconcile";
  if (/temporar(?:y|ily)|try again|server is busy|too many requests/.test(diagnostic)) return "retryable";
  return "review_required";
}

export async function inspectStep(step: SetupStep, runner: RemoteRunner): Promise<StepObservation> {
  return parseObserved(step, await runner(step.inspect.argv));
}

export async function applySetupPlan(plan: IncusSetupPlan, runner: RemoteRunner, options: { execute?: boolean; approvedPlanDigest?: string; preflightPlan?: IncusSetupPlan } = {}): Promise<ApplyReceipt> {
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
    if (before === "match") { receipts.push({ id: step.id, before, action: "skipped", outcome: "succeeded" }); continue; }
    if (before === "drift") { receipts.push({ id: step.id, before, action: "stopped", outcome: "review_required" }); return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: "review_required", steps: receipts }; }
    if (!options.execute) { receipts.push({ id: step.id, before, action: "planned", outcome: "succeeded" }); continue; }
    const result = await runner(step.apply.argv, step.apply.stdin);
    const outcome = classifyApplyResult(result);
    if (outcome !== "succeeded") {
      receipts.push({ id: step.id, before, action: "stopped", outcome, exitCode: result.exitCode });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: outcome === "review_required" ? "review_required" : "reconcile_required", steps: receipts };
    }
    const after = await inspectStep(step, runner);
    if (after !== "match") {
      receipts.push({ id: step.id, before, action: "stopped", outcome: "reconcile", exitCode: result.exitCode });
      return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: false, state: "reconcile_required", steps: receipts };
    }
    receipts.push({ id: step.id, before, action: "executed", outcome: "succeeded", exitCode: result.exitCode });
  }
  return { schemaVersion: SETUP_SCHEMA_VERSION, planDigest: plan.planDigest, dryRun: !options.execute, state: options.execute ? "applied" : "dry_run", steps: receipts };
}
