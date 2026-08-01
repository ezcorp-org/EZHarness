/**
 * The graph walk over `kind: "workflow"` edges — ONE implementation, two
 * callers.
 *
 * `validateWorkflow` needs it to reject a cycle and an over-deep nest at
 * definition time; C3's consent hash needs the same set of definitions,
 * because a capability smuggled into a *transitively* nested workflow is
 * still a capability the consenting human never saw (design record §5, T4).
 *
 * They are deliberately the same walk. Two walks would eventually disagree
 * about which definitions are "inside" a workflow, and the direction that
 * disagreement fails is a hash that misses a nested edit the validator
 * happily accepted — the exact hole the transitive closure exists to close.
 *
 * Pure: no I/O, no clock. The caller supplies a {@link WorkflowResolver},
 * which is how the same function serves the API route (resolving against
 * the live merged cache), a loader (resolving against the batch it just
 * read) and a test (resolving against a literal map).
 */
import type { WorkflowDefinition } from "../types";

/**
 * How many levels of nesting are allowed BELOW the root.
 *
 * 3, per the design record. The root itself is depth 0, so a chain
 * `root → a → b → c` is legal and `root → a → b → c → d` is not.
 *
 * Enforced in two places on purpose: here, statically, wherever the whole
 * graph is knowable, and again at RUN time by the executor's own counter.
 * Only the run-time check is authoritative — a nested chain can be formed
 * across sources (a YAML workflow naming a DB row that names an extension
 * asset) whose full shape no single definition-time caller can see.
 */
export const MAX_WORKFLOW_NESTING_DEPTH = 3;

/** Resolve a workflow NAME to its definition, or `undefined` when the
 *  caller's view of the world does not contain it. */
export type WorkflowResolver = (name: string) => WorkflowDefinition | undefined;

/**
 * The nested definition names this graph references directly, in
 * declaration order, de-duplicated.
 *
 * Reads `step.kind === "workflow"` literally rather than through
 * `stepKind()`: the default kind is `"agent"`, so a missing `kind` can
 * never be a nested edge, and inlining the check keeps this module free of
 * an import cycle with the validator that consumes it.
 */
export function nestedWorkflowNames(def: WorkflowDefinition): string[] {
  const names: string[] = [];
  for (const step of def.steps ?? []) {
    if (step?.kind !== "workflow") continue;
    const name = step.workflow;
    if (typeof name !== "string" || name === "" || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

export interface WorkflowClosure {
  /**
   * Every definition reachable from the root through `kind: "workflow"`
   * edges, ROOT FIRST, then in first-encountered order. De-duplicated by
   * name — a diamond contributes its shared leaf once.
   */
  definitions: WorkflowDefinition[];
  /** Each entry is the path that closes a loop, e.g.
   *  `["a", "b", "a"]` — named so the error can point at the cycle. */
  cycles: string[][];
  /** Names the resolver could not answer, in encounter order. */
  unresolved: string[];
  /** Names reached below {@link MAX_WORKFLOW_NESTING_DEPTH}. */
  tooDeep: string[];
}

/**
 * Walk the nesting graph from `root`.
 *
 * Never throws and never recurses without bound: a cycle is DETECTED
 * (against the current path) rather than followed, and the depth cap stops
 * a long chain. Both are reported instead of thrown, because the two
 * callers want different things from them — the validator turns them into
 * error strings, the hash only wants `definitions`.
 *
 * Expansion is memoized on `depth:name`, not on `name` alone. Memoizing on
 * the name would visit a definition reachable at two different depths only
 * at the shallower one, and silently miss a depth violation that only the
 * longer path reaches. Keying on the pair costs at most
 * `MAX_WORKFLOW_NESTING_DEPTH + 1` visits per definition and cannot.
 */
export function collectWorkflowClosure(
  root: WorkflowDefinition,
  resolve: WorkflowResolver,
  maxDepth: number = MAX_WORKFLOW_NESTING_DEPTH,
): WorkflowClosure {
  const definitions: WorkflowDefinition[] = [];
  const included = new Set<string>();
  const expanded = new Set<string>();
  const cycles: string[][] = [];
  const unresolved: string[] = [];
  const tooDeep: string[] = [];

  const include = (def: WorkflowDefinition): void => {
    if (included.has(def.name)) return;
    included.add(def.name);
    definitions.push(def);
  };

  const walk = (def: WorkflowDefinition, path: string[], depth: number): void => {
    include(def);
    for (const name of nestedWorkflowNames(def)) {
      // Order is load-bearing. A cycle is checked FIRST so a self- or
      // mutual reference is named as a cycle rather than reported as a
      // depth violation once it has bounced enough times; the depth cap is
      // checked BEFORE the resolver so an over-deep name is reported even
      // when nothing can resolve it.
      const loopAt = path.indexOf(name);
      if (loopAt !== -1) {
        cycles.push([...path.slice(loopAt), name]);
        continue;
      }
      if (depth + 1 > maxDepth) {
        tooDeep.push(name);
        continue;
      }
      const child = resolve(name);
      if (child === undefined) {
        unresolved.push(name);
        continue;
      }
      const memo = `${depth + 1}:${name}`;
      if (expanded.has(memo)) {
        // Already expanded at this exact depth — its own children were
        // walked then. Still worth INCLUDING, because the closure is a set
        // of definitions and a diamond's leaf belongs in it.
        include(child);
        continue;
      }
      expanded.add(memo);
      walk(child, [...path, name], depth + 1);
    }
  };

  expanded.add(`0:${root.name}`);
  walk(root, [root.name], 0);
  return { definitions, cycles, unresolved, tooDeep };
}
