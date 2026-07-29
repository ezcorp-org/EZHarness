/**
 * Preparing a step's result for `workflow_step_runs.output`, and reading
 * it back.
 *
 * This column is a **resume prerequisite**, not telemetry. `stepResults`
 * is an in-memory `Map<string, AgentResult>` that ANY later step can
 * address via `$steps.<name>` — not just the immediately preceding batch
 * — so a resumed run has to rehydrate the whole map, and this column is
 * the only place it can come from.
 *
 * That makes fidelity the governing concern. Two things can make a stored
 * output differ from what the step actually produced — redaction and the
 * size cap — and the difference between them matters:
 *
 *   • **Redaction** rewrites credential-shaped substrings. Accepted: the
 *     alternative is writing live keys into a table the run-history UI
 *     renders, and a ref that reads a redacted field still resolves to a
 *     string of the same type.
 *
 *   • **Truncation** cannot be accepted, because there is no honest way
 *     to resume from a value we no longer have. An oversized output is
 *     therefore replaced by a SENTINEL, and a resume that meets one fails
 *     closed rather than continuing with a silently-different `$steps`
 *     value. Failing loudly beats a run whose second half saw different
 *     inputs than its first.
 */
import type { AgentResult } from "../types";
import type { TruncatedStepOutput } from "../db/schema";
import { redactSecretsDeep } from "./secret-redaction";

/**
 * Per-step cap on the stored output, in bytes of UTF-8 JSON.
 *
 * 256 KB is far above any realistic step result (an LLM answer, a tool's
 * JSON payload) and far below anything that would bloat the run-history
 * table. The cap exists to stop one pathological step — a tool that
 * returns a whole file — from making every future read of this run
 * expensive.
 */
export const MAX_STEP_OUTPUT_BYTES = 256 * 1024;

/** Is this stored output the overflow sentinel rather than a real result? */
export function isTruncatedStepOutput(
  value: unknown,
): value is TruncatedStepOutput {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { __truncated?: unknown }).__truncated === true
  );
}

/**
 * Redact, measure, and either return the storable result or the overflow
 * sentinel.
 *
 * Three ordering decisions, each load-bearing:
 *
 * 1. **The serializability gate runs FIRST.** A self-referential value
 *    would blow the stack inside the redaction walk — the recursion has
 *    no cycle guard because the only inputs are JSON-shaped results from
 *    agents, transforms and tools. Probing with `JSON.stringify` before
 *    walking turns "crash the run" into "store NULL and fail closed on
 *    resume", which is the behaviour the column's contract promises.
 *
 * 2. **Redaction runs before measurement.** `[REDACTED]` is shorter than
 *    the credential it replaces, so measuring first would reject
 *    payloads that do in fact fit and make their steps needlessly
 *    unrecoverable.
 *
 * 3. **The cap is `>`, not `>=`.** A result landing exactly on the cap is
 *    storable.
 *
 * Returns `undefined` when there is nothing faithful to store. The caller
 * writes SQL NULL, and a resume treats a completed step with no output
 * exactly like a truncated one. Keeping that decision here — rather than
 * in the caller's `catch` — is what stops a half-value reaching a row a
 * resume would trust.
 */
export function prepareStepOutput(
  result: AgentResult,
): AgentResult | TruncatedStepOutput | undefined {
  try {
    JSON.stringify(result);
  } catch {
    return undefined;
  }
  const redacted = redactSecretsDeep(result) as AgentResult;
  // Cannot throw: redaction maps strings to strings and rebuilds plain
  // objects/arrays, so it preserves serializability.
  const bytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
  if (bytes > MAX_STEP_OUTPUT_BYTES) return { __truncated: true, bytes };
  return redacted;
}
