/**
 * Unit tests for the workflow runtime-registry — the indirection that lets
 * the backend `ezcorp/workflows` handler reach the web-layer
 * `WorkflowExecutor` + the live merged workflow cache. Mirrors the contract
 * of preview-bus-registry / briefing runtime-registry / github-projects
 * bus-registry: register once, read back, default to null (so the handler
 * degrades to a typed soft-fail instead of crashing).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  registerWorkflowRuntime,
  getWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
  type WorkflowRuntime,
} from "../runtime-registry";
import type { WorkflowDefinition, WorkflowRun } from "../../../types";

function stubRun(name: string): WorkflowRun {
  return {
    id: "run-1",
    workflowName: name,
    status: "success",
    startedAt: 0,
    steps: [],
  };
}

function stubRuntime(
  workflows: WorkflowDefinition[],
  onRun?: (name: string) => void,
): WorkflowRuntime {
  return {
    workflowExecutor: {
      // Type-only: these doubles exercise the trigger path, which never
      // resumes. Throws rather than returning a value so an accidental
      // call fails loudly instead of silently passing.
      async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
      },
      async runWorkflow(workflow) {
        onRun?.(workflow.name);
        return stubRun(workflow.name);
      },
    },
    getWorkflows: () => workflows,
  };
}

const DEF: WorkflowDefinition = { name: "wf-a", description: "", steps: [] };

describe("workflow runtime-registry", () => {
  beforeEach(() => {
    _resetWorkflowRuntimeForTests();
  });

  test("returns null when nothing is registered (fail-safe degrade)", () => {
    expect(getWorkflowRuntime()).toBeNull();
  });

  test("registered runtime is read back and both members work", async () => {
    const ran: string[] = [];
    registerWorkflowRuntime(stubRuntime([DEF], (n) => ran.push(n)));

    const got = getWorkflowRuntime();
    expect(got).not.toBeNull();
    expect(got?.getWorkflows()).toEqual([DEF]);

    const run = await got?.workflowExecutor.runWorkflow(DEF, {});
    expect(run?.workflowName).toBe("wf-a");
    expect(ran).toEqual(["wf-a"]);
  });

  test("re-registering replaces the previous runtime (idempotent register)", () => {
    const second: WorkflowDefinition = { name: "wf-b", description: "", steps: [] };
    registerWorkflowRuntime(stubRuntime([DEF]));
    registerWorkflowRuntime(stubRuntime([second]));

    expect(getWorkflowRuntime()?.getWorkflows()).toEqual([second]);
  });

  test("_resetWorkflowRuntimeForTests clears the registration", () => {
    registerWorkflowRuntime(stubRuntime([DEF]));
    expect(getWorkflowRuntime()).not.toBeNull();
    _resetWorkflowRuntimeForTests();
    expect(getWorkflowRuntime()).toBeNull();
  });

  test("getWorkflows is a THUNK — a replaced cache array is observed live", () => {
    // The exact staleness bug the thunk exists to prevent: context.ts
    // REASSIGNS its module-level `workflows` binding on every CRUD write
    // (reloadWorkflows), so a by-value registration would freeze the list.
    let cache: WorkflowDefinition[] = [DEF];
    registerWorkflowRuntime({
      workflowExecutor: {
        async runWorkflow(w) {
          return stubRun(w.name);
        },
        // Type-only — this double never resumes; throwing keeps an
        // accidental call loud.
        async resumeWorkflow() {
          throw new Error("not exercised");
        },
      },
      getWorkflows: () => cache,
    });

    expect(getWorkflowRuntime()?.getWorkflows()).toEqual([DEF]);

    const reloaded: WorkflowDefinition = { name: "wf-new", description: "", steps: [] };
    cache = [DEF, reloaded];

    expect(getWorkflowRuntime()?.getWorkflows()).toEqual([DEF, reloaded]);
  });
});
