// Shared pure-function module for task dependency analysis.
//
// Extracted from src/runtime/tools/task-tracking.ts:277-362 during Phase 3
// so the task-tracking bundled extension and the host's `/start` endpoint
// pre-start gate share one implementation. No side effects, no I/O — just
// graph-shape checks over a snapshot.
//
// The types here are deliberately narrower than the full TrackedTask /
// TaskSnapshot shapes: consumers only need `id`, `status`, and `dependsOn`
// for block/cycle reasoning. Keeping the surface tight lets the bundled
// extension import this file via a relative path without dragging in the
// host's type graph.
//
// NOT imported by the SDK (`packages/@ezcorp/sdk`). If a second extension
// ever needs these primitives the right move is to re-extract into
// `@ezcorp/task-core`; for now the relative-path import from a bundled
// extension is the simpler shape.
//
// Invariants preserved from the built-in origin:
//   - Unknown dep ids are treated as *satisfied*, not as blockers — a
//     deleted task must not leave a dangling task permanently stuck.
//   - `isBlocked` only applies to tasks whose own status is "pending";
//     an "active"/"completed"/"failed" task is never reported blocked.
//   - Cycle detection is iterative DFS (no recursion) — long dependency
//     chains must not overflow the stack.

export type TaskStatus = "pending" | "active" | "completed" | "failed";

/** Minimum task shape for dependency analysis. */
export interface ReadonlyTask {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn?: string[];
}

export interface ReadonlySnapshot {
  tasks: ReadonlyTask[];
}

/**
 * Return the prerequisite tasks that are not yet `completed` for a given
 * task. Entries in `dependsOn` that don't resolve to a current task are
 * silently dropped (treated as satisfied) so a deleted prereq doesn't
 * leave a dependent pinned forever.
 */
export function unsatisfiedDeps(
  task: ReadonlyTask,
  snap: ReadonlySnapshot,
): ReadonlyTask[] {
  if (!task.dependsOn || task.dependsOn.length === 0) return [];
  const out: ReadonlyTask[] = [];
  for (const depId of task.dependsOn) {
    const dep = snap.tasks.find((t) => t.id === depId);
    if (!dep) continue;
    if (dep.status !== "completed") out.push(dep);
  }
  return out;
}

/**
 * A task is "blocked" when it's still `pending` and at least one
 * prerequisite isn't `completed`. Blocked tasks cannot auto-start or
 * be manually started; they wait until the last prerequisite completes.
 */
export function isBlocked(task: ReadonlyTask, snap: ReadonlySnapshot): boolean {
  if (task.status !== "pending") return false;
  return unsatisfiedDeps(task, snap).length > 0;
}

/**
 * Detect a cycle in the dependency graph of the given task list. Returns
 * the cycle path as an array of task titles (ids as fallback) if a cycle
 * exists, otherwise null. Iterative DFS so deep chains don't overflow.
 */
export function detectCycle(tasks: ReadonlyTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  const label = (id: string): string => byId.get(id)?.title ?? id;

  const dfs = (startId: string): string[] | null => {
    const stack: Array<{ id: string; iter: Iterator<string> }> = [];
    color.set(startId, GRAY);
    parent.set(startId, null);
    const startTask = byId.get(startId);
    stack.push({ id: startId, iter: (startTask?.dependsOn ?? [])[Symbol.iterator]() });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const depId = next.value as string;
      if (!byId.has(depId)) continue;
      const c = color.get(depId) ?? WHITE;
      if (c === GRAY) {
        const cycle: string[] = [label(depId)];
        let cur: string | null = frame.id;
        while (cur && cur !== depId) {
          cycle.unshift(label(cur));
          cur = parent.get(cur) ?? null;
        }
        cycle.unshift(label(depId));
        return cycle;
      }
      if (c === WHITE) {
        color.set(depId, GRAY);
        parent.set(depId, frame.id);
        const depTask = byId.get(depId);
        stack.push({ id: depId, iter: (depTask?.dependsOn ?? [])[Symbol.iterator]() });
      }
    }
    return null;
  };

  for (const t of tasks) {
    if ((color.get(t.id) ?? WHITE) !== WHITE) continue;
    const cycle = dfs(t.id);
    if (cycle) return cycle;
  }
  return null;
}
