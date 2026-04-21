/**
 * DAG cycle detection for agent reference graphs.
 *
 * Given an agent about to gain new references, checks whether
 * adding those references would create a cycle in the agent DAG.
 */
export function detectCycle(
  agentId: string,
  references: string[],
  allRefs: Map<string, string[]>,
): string[] | null {
  // Temporarily add the proposed references
  const prev = allRefs.get(agentId);
  allRefs.set(agentId, references);

  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (path.includes(node)) {
      // Found cycle — return the cycle portion + closing node
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    path.push(node);
    const refs = allRefs.get(node) ?? [];
    for (const ref of refs) {
      const cycle = dfs(ref);
      if (cycle) return cycle;
    }
    path.pop();
    visited.add(node);
    return null;
  }

  const result = dfs(agentId);

  // Restore original state
  if (prev !== undefined) {
    allRefs.set(agentId, prev);
  } else {
    allRefs.delete(agentId);
  }

  return result;
}
