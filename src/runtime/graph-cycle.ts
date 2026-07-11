/**
 * Generic depth-first cycle detection over a directed graph (DRY, C4).
 *
 * A single reusable detector for the host's graph-shape checks. `detectCycle`
 * walks from `start`, following the out-edges `edgesOf(node)` returns, and
 * reports the first cycle reachable from `start` as the path
 * `[repeatedNode, …intermediate, repeatedNode]` — the same shape the agent-DAG
 * validator (`dag-validator.ts`) has always produced — or `null` for an
 * acyclic reachable subgraph.
 *
 * NOTE — the task-tracking extension keeps its OWN colocated cycle detector
 * (`docs/extensions/examples/task-tracking/task-dependencies.ts`) and does NOT
 * consume this module. That code runs inside the landlock/bwrap jail, which
 * grants file-READ only to the extension's own dir; a runtime value-import
 * from `src/**` dies at module load with EACCES (issue #60). Consolidating it
 * here would reintroduce that crash, so it is deliberately left independent.
 */

/**
 * Detect a cycle reachable from `start`.
 *
 * @param start   The node id to start the walk from.
 * @param edgesOf Out-edges of a node (ids). May be called for nodes with no
 *                entry — return an empty array for unknown nodes.
 * @returns The cycle path `[node, …, node]` (repeated node at both ends), or
 *          `null` when no cycle is reachable from `start`.
 */
export function detectCycle(
  start: string,
  edgesOf: (node: string) => string[],
): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (path.includes(node)) {
      // Found a cycle — return the path slice from the first occurrence plus
      // the closing (repeated) node.
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    path.push(node);
    for (const next of edgesOf(node)) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    path.pop();
    visited.add(node);
    return null;
  }

  return dfs(start);
}
