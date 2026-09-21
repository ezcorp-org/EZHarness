import { digestObject } from "../../extensions/v4/blobs";
import {
  workflowClosureCapabilities,
  type ConsentHashSources,
} from "../../runtime/workflow-capability-hash";
import { workflowExecutionHash } from "../../runtime/workflow-definition-hash";
import type { CachedWorkflow } from "../../runtime/workflow-scope";
import type { WorkflowDefinition } from "../../types";

export const LEGACY_WORKFLOW_CLASSIFICATION_SCHEMA_VERSION = "factory.legacy-classification.v1" as const;

/** Why one capability key puts a legacy workflow outside the allowlist. */
export type LegacyWorkflowFindingReason =
  | "shell"
  | "network"
  | "mcp"
  | "unclassified-capability"
  | "unreachable-tool"
  | "unreachable-agent"
  | "unresolved-workflow"
  | "workflow-cycle"
  | "workflow-too-deep";

/**
 * The static non-publishing allowlist, stated as its complement.
 *
 * C10 names shell, MCP, `git`, and any network-capable extension tool.
 * `git` has no capability of its own in this codebase: every git path
 * (`project-git-broker.ts`, `project-pr-broker.ts`,
 * `project-pull-request-broker.ts`) requires `shell`, so excluding `shell`
 * is exactly what excludes `git`. There is no finer static signal, and a
 * classifier that looked for the string `git` would pass `/usr/bin/git`.
 *
 * The two `:unreachable` markers are here because a tool or agent the host
 * cannot resolve is a step whose authority cannot be read at all. Admitting
 * it would classify by absence of evidence. `custom` is the same argument
 * for a declared capability the host has no kind for.
 *
 * One table, so the denied set and the reason it reports can never drift.
 */
const DENIED_CAPABILITY_KINDS: ReadonlyMap<string, LegacyWorkflowFindingReason> = new Map([
  ["shell", "shell"],
  ["network", "network"],
  ["network.tcp", "network"],
  ["http", "network"],
  ["ezcorp:mcp:invoke", "mcp"],
  ["custom", "unclassified-capability"],
  ["tool:unreachable", "unreachable-tool"],
  ["agent:unreachable", "unreachable-agent"],
]);

/** The denied capability kinds, for a caller that wants to show the rule. */
export const LEGACY_WORKFLOW_DENIED_CAPABILITY_KINDS: readonly string[] = Object.freeze(
  [...DENIED_CAPABILITY_KINDS.keys()].sort(),
);

/** One reason a workflow is not admitted to the allowlist. */
export interface LegacyWorkflowFinding {
  /**
   * The definition in the closure that carries it.
   *
   * Attribution is per definition rather than per step because that is what
   * the one shared closure walk produces. The union over a definition's
   * steps is a sound over-approximation of any single step's set: a
   * capability present on no step cannot appear in it.
   */
  readonly workflowName: string;
  readonly reason: LegacyWorkflowFindingReason;
  /** The `kind::value` capability key, or the nested name that could not be walked. */
  readonly detail: string;
}

export interface LegacyWorkflowClassification {
  readonly schemaVersion: typeof LEGACY_WORKFLOW_CLASSIFICATION_SCHEMA_VERSION;
  /** `workflowExecutionHash` of the exact graph that will run. */
  readonly definitionDigest: string;
  /** `non-publishing` may be wrapped directly; `publishing` needs an attestation. */
  readonly verdict: "non-publishing" | "publishing";
  /** Every definition name in the closure, sorted. */
  readonly closure: readonly string[];
  /** Sorted, de-duplicated `kind::value` across the whole closure. */
  readonly capabilities: readonly string[];
  /** Empty exactly when the verdict is `non-publishing`. */
  readonly findings: readonly LegacyWorkflowFinding[];
}

function capabilityFindings(workflowName: string, capabilities: readonly string[]): LegacyWorkflowFinding[] {
  const found: LegacyWorkflowFinding[] = [];
  for (const key of capabilities) {
    const reason = DENIED_CAPABILITY_KINDS.get(key.slice(0, key.indexOf("::")));
    if (reason !== undefined) found.push({ workflowName, reason, detail: key });
  }
  return found;
}

/**
 * Classifies one pinned legacy workflow version from its definition alone.
 *
 * Pure and deterministic: the same definition and the same resolver always
 * produce the same verdict and the same digest, which is what lets an
 * attestation bind to it. It reads the SAME closure the consent hash reads
 * (`workflowClosureCapabilities`), so a nested step cannot be inside one
 * view and outside the other.
 *
 * A walk that could not finish — an unresolved nested name, a cycle, or a
 * name below the depth cap — is a finding, not a pass. An edge pointing
 * nowhere today can resolve tomorrow, and the graph would silently gain a
 * live step under an attestation taken before it existed.
 */
export function classifyLegacyWorkflow(
  root: WorkflowDefinition,
  sources: ConsentHashSources,
  release?: CachedWorkflow["extensionRelease"],
): LegacyWorkflowClassification {
  const closure = workflowClosureCapabilities(root, sources);
  const findings: LegacyWorkflowFinding[] = [];
  for (const definition of closure.graph) findings.push(...capabilityFindings(definition.name, definition.capabilities));
  for (const name of closure.unresolved) findings.push({ workflowName: root.name, reason: "unresolved-workflow", detail: name });
  for (const path of closure.cycles) findings.push({ workflowName: root.name, reason: "workflow-cycle", detail: path });
  for (const name of closure.tooDeep) findings.push({ workflowName: root.name, reason: "workflow-too-deep", detail: name });
  return Object.freeze({
    schemaVersion: LEGACY_WORKFLOW_CLASSIFICATION_SCHEMA_VERSION,
    definitionDigest: workflowExecutionHash(root, release),
    verdict: findings.length === 0 ? "non-publishing" : "publishing",
    closure: Object.freeze(closure.graph.map(definition => definition.name)),
    capabilities: Object.freeze([...new Set(closure.graph.flatMap(definition => definition.capabilities))].sort()),
    findings: Object.freeze(findings),
  });
}

/**
 * The digest an attestation binds to.
 *
 * Over the whole classification, not only the definition digest: the verdict
 * depends on what the host could resolve at classification time, so an
 * attestation must also stop being valid when a previously unreachable tool
 * becomes reachable with a wider grant than the administrator saw.
 */
export function legacyWorkflowClassificationDigest(classification: LegacyWorkflowClassification): string {
  return `sha256:${digestObject(classification)}`;
}
