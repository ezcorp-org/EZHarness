/**
 * DAG cycle detection for agent reference graphs.
 *
 * Given an agent about to gain new references, checks whether
 * adding those references would create a cycle in the agent DAG.
 *
 * Thin adapter over the generic `detectCycle` in `./graph-cycle` (C4): it
 * temporarily installs the proposed references, walks from the agent, and
 * restores the map — preserving the historical `[node, …, node]` cycle-path
 * contract this module's callers + tests depend on.
 */
import { detectCycle as detectCycleGeneric } from "./graph-cycle";

export function detectCycle(
  agentId: string,
  references: string[],
  allRefs: Map<string, string[]>,
): string[] | null {
  // Temporarily add the proposed references so the walk sees them.
  const prev = allRefs.get(agentId);
  allRefs.set(agentId, references);

  try {
    return detectCycleGeneric(agentId, (node) => allRefs.get(node) ?? []);
  } finally {
    // Restore original state (never mutate the caller's map).
    if (prev !== undefined) {
      allRefs.set(agentId, prev);
    } else {
      allRefs.delete(agentId);
    }
  }
}
