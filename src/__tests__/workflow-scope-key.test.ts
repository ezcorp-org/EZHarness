/**
 * `src/runtime/workflow-scope-key.ts` — the single definition of the
 * synthetic `workflow-run:<id>` conversation coordinate.
 *
 * Two things are under test and they pull in opposite directions:
 *
 *   1. RECOGNITION must be exact. A false positive turns a real
 *      conversation's tool call into an orphan row with a NULL
 *      conversation, silently detaching it from the panel that shows it.
 *   2. TRANSLATION must be total. A false negative sends the synthetic key
 *      back at a `conversations` FK, which is the bug this module exists to
 *      close — every workflow tool call rejected by the database and logged
 *      as `Failed to persist tool:complete`.
 *
 * The prefix constant is asserted by VALUE, once. It is a wire-visible
 * coordinate that `runtime/tools/permissions.ts` re-exports and the
 * ez-factory tools restate independently, so a "harmless" rename would
 * silently stop the permission gate recognising a workflow scope.
 */
import { test, expect, describe } from "bun:test";
import {
  WORKFLOW_SCOPE_KEY_PREFIX,
  isWorkflowScopeKey,
  persistableConversationId,
  workflowRunIdFromScopeKey,
  workflowScopeKey,
} from "../runtime/workflow-scope-key";
import { NON_INTERACTIVE_KEY_PREFIX } from "../runtime/tools/permissions";

const RUN_ID = "0f9a1c3e-2b44-4d5a-8f61-9c0d2e7a1b83";

describe("the prefix", () => {
  test("is the exact wire-visible value the rest of the host expects", () => {
    expect(WORKFLOW_SCOPE_KEY_PREFIX).toBe("workflow-run:");
  });

  test("is the SAME object the permission gate recognises", () => {
    // `permissions.ts` used to carry its own copy of the literal. If the
    // two ever diverge, `assertNonInteractiveScope` stops recognising a
    // key the executor mints — an entire class of gate check quietly
    // going missing. Identity, not equality: an alias cannot drift.
    expect(NON_INTERACTIVE_KEY_PREFIX).toBe(WORKFLOW_SCOPE_KEY_PREFIX);
  });
});

describe("workflowScopeKey", () => {
  test("mints prefix + run id", () => {
    expect(workflowScopeKey(RUN_ID)).toBe(`workflow-run:${RUN_ID}`);
  });

  test("what it mints is what the recognisers accept — round trip", () => {
    const key = workflowScopeKey(RUN_ID);
    expect(isWorkflowScopeKey(key)).toBe(true);
    expect(workflowRunIdFromScopeKey(key)).toBe(RUN_ID);
    expect(persistableConversationId(key)).toBeNull();
  });
});

describe("isWorkflowScopeKey", () => {
  test("true for a minted key", () => {
    expect(isWorkflowScopeKey(`workflow-run:${RUN_ID}`)).toBe(true);
  });

  test("false for a real conversation id (a bare uuid)", () => {
    expect(isWorkflowScopeKey(RUN_ID)).toBe(false);
  });

  test("false for a near-miss that only CONTAINS the prefix", () => {
    // `startsWith`, never `includes`: a conversation whose id embedded the
    // token would otherwise lose its own tool calls.
    expect(isWorkflowScopeKey(`conv-workflow-run:${RUN_ID}`)).toBe(false);
  });

  test("false for null, undefined and the empty string", () => {
    expect(isWorkflowScopeKey(null)).toBe(false);
    expect(isWorkflowScopeKey(undefined)).toBe(false);
    expect(isWorkflowScopeKey("")).toBe(false);
  });
});

describe("workflowRunIdFromScopeKey", () => {
  test("recovers the run id", () => {
    expect(workflowRunIdFromScopeKey(`workflow-run:${RUN_ID}`)).toBe(RUN_ID);
  });

  test("null for a bare prefix — it names no run", () => {
    // The row would otherwise carry `workflowRunId: ""`, which reads as a
    // run id and matches nothing. Absent is the honest answer.
    expect(workflowRunIdFromScopeKey("workflow-run:")).toBeNull();
  });

  test("null for a real conversation id and for nothing at all", () => {
    expect(workflowRunIdFromScopeKey(RUN_ID)).toBeNull();
    expect(workflowRunIdFromScopeKey(null)).toBeNull();
    expect(workflowRunIdFromScopeKey(undefined)).toBeNull();
  });
});

describe("persistableConversationId", () => {
  test("NULLs a synthetic key — the FK cannot hold it", () => {
    expect(persistableConversationId(`workflow-run:${RUN_ID}`)).toBeNull();
  });

  test("passes a real conversation id through UNCHANGED", () => {
    // The load-bearing negative: if this ever returned null for a chat
    // tool call, every conversation's observability panel would go blank
    // and nothing would error.
    expect(persistableConversationId(RUN_ID)).toBe(RUN_ID);
  });

  test("NULLs the absent cases rather than storing a sentinel", () => {
    expect(persistableConversationId(null)).toBeNull();
    expect(persistableConversationId(undefined)).toBeNull();
    expect(persistableConversationId("")).toBeNull();
  });
});
