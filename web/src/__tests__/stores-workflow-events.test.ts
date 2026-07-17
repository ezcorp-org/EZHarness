/**
 * Tests the routing of `workflow:*` runtime events into `store.workflowRuns`.
 *
 * The real handlers live inside stores.svelte.ts (around line 887), which uses
 * Svelte 5 runes and can't be cleanly imported into `bun test`. The routing is
 * extracted here as a pure reducer with the SAME branches:
 *   - `workflow:start` prepends the new run,
 *   - `workflow:step` / `workflow:complete` / `workflow:error` replace the run
 *     with the matching id (leaving every other run untouched).
 *
 * Kept in lockstep with the real handler — any drift should surface in review
 * (both must be edited together).
 */
import { test, expect, describe } from "bun:test";

interface WorkflowRunLike {
  id: string;
  status: string;
}

type WorkflowEvent =
  | { type: "workflow:start"; workflowRun: WorkflowRunLike }
  | { type: "workflow:step"; workflowRun: WorkflowRunLike }
  | { type: "workflow:complete"; workflowRun: WorkflowRunLike }
  | { type: "workflow:error"; workflowRun: WorkflowRunLike };

/** Mirror of the `workflow:*` arms of processEvent in stores.svelte.ts. */
function reduceWorkflowRuns(
  runs: WorkflowRunLike[],
  event: WorkflowEvent,
): WorkflowRunLike[] {
  switch (event.type) {
    case "workflow:start":
      return [event.workflowRun, ...runs];
    case "workflow:step":
    case "workflow:complete":
    case "workflow:error":
      return runs.map((r) => (r.id === event.workflowRun.id ? event.workflowRun : r));
  }
}

describe("stores.svelte.ts workflow:* run routing", () => {
  test("workflow:start prepends the new run", () => {
    const before = [{ id: "old", status: "success" }];
    const after = reduceWorkflowRuns(before, {
      type: "workflow:start",
      workflowRun: { id: "new", status: "running" },
    });
    expect(after.map((r) => r.id)).toEqual(["new", "old"]);
  });

  test.each(["workflow:step", "workflow:complete", "workflow:error"] as const)(
    "%s replaces the matching run in place and leaves siblings untouched",
    (type) => {
      const before = [
        { id: "a", status: "running" },
        { id: "b", status: "running" },
      ];
      const after = reduceWorkflowRuns(before, {
        type,
        workflowRun: { id: "b", status: "success" },
      });
      expect(after).toEqual([
        { id: "a", status: "running" },
        { id: "b", status: "success" },
      ]);
    },
  );

  test("a terminal event for an unknown id is a no-op (no run replaced)", () => {
    const before = [{ id: "a", status: "running" }];
    const after = reduceWorkflowRuns(before, {
      type: "workflow:complete",
      workflowRun: { id: "ghost", status: "success" },
    });
    expect(after).toEqual(before);
  });
});
