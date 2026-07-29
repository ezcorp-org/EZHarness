/**
 * The editor's raw-YAML tab, as framework-free logic.
 *
 * Uses the SAME `yaml` package the server's `workflow-loader.ts` parses
 * `*.workflow.yaml` assets with, so a definition that round-trips here
 * parses identically on the server. A second YAML dialect in the browser
 * would let the editor accept a document the loader rejects.
 *
 * This module deliberately does NOT validate. `validateWorkflow`
 * (`src/runtime/workflow-validator.ts`) is the one validator, shared by
 * the API and the YAML loader, and the editor calls it for live feedback
 * while the route calls it as the real gate — the client copy is UX,
 * never enforcement.
 */
import { parse, stringify } from "yaml";

export type YamlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse the YAML tab into a definition object.
 *
 * A document that parses to a scalar, a list, or nothing is rejected
 * here rather than passed on: `validateWorkflow` would report "Workflow
 * must have a non-empty name" for `- a\n- b`, which tells the user
 * nothing about what actually went wrong.
 */
export function parseWorkflowYaml(text: string): YamlParseResult {
  if (text.trim() === "") return { ok: false, error: "Definition is empty" };
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Definition must be a YAML mapping (name, description, steps)" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Render a definition into the YAML tab.
 *
 * Keys are emitted in a fixed, human order rather than object order:
 * `name` and `description` first, then the executable content. A user
 * switching from the form tab should see a document that reads like one
 * a human wrote, not the field order the API happened to serialize.
 * Undefined members are dropped so the tab never shows `inputSchema: null`.
 */
export function workflowToYaml(definition: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["name", "description", "inputSchema", "defaultModel", "steps"]) {
    const value = definition[key];
    if (value !== undefined && value !== null) ordered[key] = value;
  }
  return stringify(ordered, { lineWidth: 0 });
}

/**
 * The subset of a wire workflow that may be SAVED.
 *
 * The single-workflow GET returns the definition plus provenance
 * (`visibility`, `canEdit`, `source`, …), and the PUT body schema is
 * `.strict()` — so echoing the whole object back would 400. Stripping is
 * done here, once, rather than at each of the editor's two tabs.
 */
export function definitionFields(workflow: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "description", "inputSchema", "defaultModel", "steps"]) {
    if (workflow[key] !== undefined && workflow[key] !== null) out[key] = workflow[key];
  }
  return out;
}
