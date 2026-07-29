/**
 * A stable fingerprint of the parts of a workflow definition that decide
 * how a run executes.
 *
 * ## Why a run needs one
 *
 * A suspended run resumes from `cursor.batchIndex`, which is only a
 * meaningful coordinate because `resolveExecutionOrder` is pure: the same
 * definition always yields the same batches. A run parked for a day can
 * resume against an EDITED definition, where batch 3 is a different set
 * of steps entirely — so the cursor would point somewhere the operator
 * never authorized, skipping steps or re-running them.
 *
 * There is no compensating control for that today, so resume compares
 * this hash and fails closed on a mismatch. Definition versioning will
 * later replace the hash with a real version id; until then this is the
 * whole guard.
 *
 * ## What it covers, and what it deliberately does not
 *
 * Only what changes EXECUTION: the step list (whose order and
 * `dependsOn` edges determine the batches) and the definition-level model
 * binding.
 *
 * `name` is excluded because resume looks the definition up BY name — a
 * differing name means a different definition, not a drifted one.
 * `description` is excluded because prose cannot change what runs, and
 * invalidating every parked run over a typo fix would be a needless
 * fail-closed with no safety benefit.
 */
import { createHash } from "node:crypto";
import type { WorkflowDefinition } from "../types";

/**
 * JSON with object keys sorted at every depth, so two structurally equal
 * definitions hash identically regardless of key insertion order (YAML
 * loaders and the DB round-trip do not agree on it).
 *
 * ARRAY order is preserved — step order is semantic here, not incidental:
 * it decides batch composition on the no-deps path and tie-breaks within
 * a batch on the topo path, which is exactly what `cursor.batchIndex` and
 * `cursor.prevStepName` are coordinates into.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members would stringify to nothing and produce invalid
    // JSON; an absent key and an explicitly-undefined one are the same
    // definition, so both must hash alike.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Hex SHA-256 over the execution-relevant slice of a definition. */
export function workflowDefinitionHash(def: WorkflowDefinition): string {
  const material = stableStringify({
    steps: def.steps ?? [],
    defaultModel: def.defaultModel,
  });
  return createHash("sha256").update(material).digest("hex");
}
