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
export function namespacedWorkflowName(
  extensionName: string,
  declaredName: string,
): string {
  return `${extensionName}${EXTENSION_WORKFLOW_SEPARATOR}${declaredName}`;
}

/** True when `name` is a well-formed BARE workflow name. */
export function isValidWorkflowName(name: unknown): name is string {
  return typeof name === "string" && WORKFLOW_NAME_RE.test(name);
}
