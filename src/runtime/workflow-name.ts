/**
 * The workflow-name grammar shared by every site that has to agree on what
 * an extension-shipped workflow is called.
 *
 * Deliberately dependency-free so the manifest validator
 * (`src/extensions/manifest.ts`), the asset loader
 * (`./workflow-extension-loader.ts`), the permission clamp
 * (`src/extensions/clamp-permissions.ts`) and the `ezcorp/workflows`
 * reverse-RPC handler can all import ONE definition. A second copy of this
 * regex anywhere is a shadowing bug waiting to happen: if the validator and
 * the loader ever disagreed about whether `:` is legal in a declared name,
 * an extension could ship a workflow whose namespaced name is ambiguous.
 */

/** Separator between the owning extension's name and the workflow's own
 *  declared name (`<extensionName>:<declaredName>`). Extension names are
 *  admit-time-validated against `/^[a-z0-9][a-z0-9-_.]{0,63}$/`, which
 *  excludes this character — so a namespaced name always carries exactly
 *  one separator and can never equal a bare host workflow name. */
export const EXTENSION_WORKFLOW_SEPARATOR = ":";

/** Grammar for the BARE name an extension declares (in its YAML asset and
 *  in `permissions.workflows.names`). Excludes the separator, whitespace
 *  and path characters, so the namespaced result is a single well-formed
 *  token that cannot be re-split ambiguously or used to traverse a path. */
export const WORKFLOW_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Build the cache name for an extension-shipped workflow. The ONE place
 *  the prefix is applied, so the loader (which writes the name) and the
 *  reverse-RPC handler (which resolves it) can never disagree. */
export function namespacedWorkflowName(extensionName: string, declaredName: string): string {
  return `${extensionName}${EXTENSION_WORKFLOW_SEPARATOR}${declaredName}`;
}

/** True when `name` is a well-formed BARE workflow name. */
export function isValidWorkflowName(name: unknown): name is string {
  return typeof name === "string" && WORKFLOW_NAME_RE.test(name);
}

/**
 * True when `name` is a well-formed name a workflow can be RESOLVED by in
 * the merged cache — a bare host name, or one namespaced
 * `<extension>:<declared>`.
 *
 * The looser twin of {@link isValidWorkflowName}, and the two are not
 * interchangeable. That one guards what an extension may DECLARE, where the
 * separator must be illegal or an extension could forge another's
 * namespace. This one guards what a caller may LOOK UP, where a namespaced
 * name is exactly the legitimate case.
 *
 * Both halves are checked against the same {@link WORKFLOW_NAME_RE}, which
 * excludes the separator — so a name carrying two of them is rejected here
 * rather than silently resolving against a re-split that means something
 * else.
 *
 * ## Why C7 needs this as a PREDICATE and not a convention
 *
 * A `kind: "workflow"` step's target is a literal name, never a ref. The
 * grammar is what enforces it: `$input.child`, `$steps.pick.output.name`
 * and `{{ … }}` all fail the leading `[a-zA-Z0-9]`, so "static" becomes a
 * definition-time error with a message instead of a run-time lookup miss.
 *
 * That matters beyond tidiness. The nesting cycle check and the depth-3 cap
 * are DEFINITION-time checks, and neither is computable against a name that
 * is not known until the run — a cycle would then be discovered only by
 * hitting the cap, after real nested runs had already applied side effects.
 * The same staticness is what lets C3 hash the transitive closure of a
 * graph at consent time: a runtime-resolved target would mean a human
 * consenting to a graph that decides later what it calls.
 */
export function isResolvableWorkflowName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const parts = name.split(EXTENSION_WORKFLOW_SEPARATOR);
  if (parts.length === 1) return isValidWorkflowName(parts[0]);
  if (parts.length !== 2) return false;
  return isValidWorkflowName(parts[0]) && isValidWorkflowName(parts[1]);
}
