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

/**
 * Per-step cap on the stored `resolved_input`, in bytes of UTF-8 JSON.
 *
 * Deliberately SMALLER than the output cap. A step's input mapping is a
 * handful of resolved refs; one large enough to need 256 KB is a smell,
 * not a use case. And unlike `output` this column is pure telemetry — a
 * resume recomputes the mapping from `cursor` + `stepResults` and never
 * reads it — so truncating one costs an operator some detail and costs
 * correctness nothing.
 */
export const MAX_RESOLVED_INPUT_BYTES = 64 * 1024;

/** Is this stored output the overflow sentinel rather than a real result? */
export function isTruncatedStepOutput(value: unknown): value is TruncatedStepOutput {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { __truncated?: unknown }).__truncated === true
  );
}

/**
 * Redact, measure, and either return the storable result or the overflow
 * sentinel. See {@link prepareForStorage} for the ordering rationale, all
 * of which applies here — this is the resume-critical caller.
 */
export function prepareStepOutput(
  result: AgentResult,
): AgentResult | TruncatedStepOutput | undefined {
  return prepareForStorage(result, MAX_STEP_OUTPUT_BYTES) as
    | AgentResult
    | TruncatedStepOutput
    | undefined;
}

/**
 * The same treatment for `workflow_step_runs.resolved_input`.
 *
 * ## Why this is four lines and not its own module
 *
 * `resolved_input` is the value the ref language produced for a step —
 * whatever the workflow author threaded in through `$input`, `$steps` or
 * `$prev`, which routinely includes credentials and always includes
 * whatever an extension tool returned. That is the same untrusted surface
 * `output` is, so it gets the same guarantee, and it gets it by calling
 * the same code rather than by a second implementation that agrees today.
 *
 * There must be exactly ONE redactor in the tree
 * (`redactSecretsDeep`) and exactly one redact-then-measure path. A
 * second one would not fail loudly when it drifted — it would keep
 * storing values, just less redacted ones, in a table the trace UI
 * renders.
 *
 * Only the cap differs; see {@link MAX_RESOLVED_INPUT_BYTES} for why it
 * is smaller.
 */
export function prepareResolvedInput(
  input: Record<string, unknown>,
): Record<string, unknown> | TruncatedStepOutput | undefined {
  return prepareForStorage(input, MAX_RESOLVED_INPUT_BYTES) as
    | Record<string, unknown>
    | TruncatedStepOutput
    | undefined;
}

/**
 * Redact, measure, and either return the storable value or the overflow
 * sentinel. The single body behind both public wrappers.
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
 * 2. **Redaction runs before measurement**, so the bytes measured are the
 *    bytes STORED. Under today's patterns every match is longer than
 *    `[REDACTED]` (the shortest, `xox?-` plus ten characters, is 15), so
 *    measuring first would only ever reject payloads that do in fact fit
 *    and make their steps needlessly unrecoverable. This order does not
 *    depend on that: it is what makes the cap mean "bytes stored"
 *    whichever way a future pattern moves the length, and it is why the
 *    overflow sentinel's `bytes` describes the value that would have been
 *    written rather than the one that came in.
 *
 * 3. **The cap is `>`, not `>=`.** A value landing exactly on the cap is
 *    storable.
 *
 * Returns `undefined` when there is nothing faithful to store. The caller
 * writes SQL NULL, and a resume treats a completed step with no output
 * exactly like a truncated one. Keeping that decision here — rather than
 * in the caller's `catch` — is what stops a half-value reaching a row a
 * resume would trust.
 */
function prepareForStorage(
  value: object,
  maxBytes: number,
): object | TruncatedStepOutput | undefined {
  try {
    JSON.stringify(value);
  } catch {
    return undefined;
  }
  const redacted = redactSecretsDeep(value) as object;
  // Cannot throw: redaction maps strings to strings and rebuilds plain
  // objects/arrays, so it preserves serializability.
  const bytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
  if (bytes > maxBytes) return { __truncated: true, bytes };
  return redacted;
}
