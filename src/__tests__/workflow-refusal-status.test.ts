/**
 * The ONE place the refusal-code → HTTP-status mapping is asserted.
 *
 * Before this table existed, four surfaces each hand-wrote it, and each
 * surface's own test asserted only the handful of statuses that surface
 * happened to produce. Nothing anywhere compared the copies, so a fifth
 * value drifting into one of them was invisible.
 *
 * Those route/Hub tests still assert their own statuses — that is what
 * proves each surface actually USES this table rather than a private
 * copy. This file asserts what the table SAYS.
 */
import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_REFUSAL_STATUS,
  workflowRefusalStatus,
  type WorkflowRefusalCode,
} from "../runtime/workflow-refusal-status";

/**
 * Every code, spelled out, with the status it has always mapped to.
 *
 * Typed as `WorkflowRefusalCode` keys so the list cannot name a code that
 * no longer exists; the `Record<WorkflowRefusalCode, number>` annotation
 * on the table itself is what makes the table exhaustive.
 */
const EXPECTED: Record<WorkflowRefusalCode, number> = {
  // Shared by both unions.
  "not-found": 404,
  forbidden: 403,
  "run-unavailable": 409,
  "resume-failed": 409,
  // `AnswerApprovalRefusal` only.
  "not-pending": 409,
  "lost-race": 409,
  "invalid-answer": 400,
  // `RunControlCode` only.
  "not-resumable": 409,
  "already-terminal": 409,
};

describe("workflow refusal → HTTP status", () => {
  for (const [code, status] of Object.entries(EXPECTED)) {
    test(`${code} → ${status}`, () => {
      expect(workflowRefusalStatus(code as WorkflowRefusalCode)).toBe(status);
      expect(WORKFLOW_REFUSAL_STATUS[code as WorkflowRefusalCode]).toBe(status);
    });
  }

  test("the table holds exactly these codes and no others", () => {
    // Guards the direction the type annotation cannot: a key added to the
    // table without a decision recorded here.
    expect(Object.keys(WORKFLOW_REFUSAL_STATUS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test("only forbidden is a 403 and only not-found is a 404", () => {
    // The two statuses that carry an authorization meaning. A new code
    // quietly joining either class is a security-shaped change, not a
    // cosmetic one.
    const byStatus = (want: number) =>
      Object.entries(WORKFLOW_REFUSAL_STATUS)
        .filter(([, s]) => s === want)
        .map(([c]) => c);
    expect(byStatus(403)).toEqual(["forbidden"]);
    expect(byStatus(404)).toEqual(["not-found"]);
  });

  test("an unknown code degrades to 400 instead of throwing", () => {
    // Each old copy ended in `?? 400`. A refusal crossing an untyped
    // boundary must still produce a response.
    expect(workflowRefusalStatus("who-knows" as WorkflowRefusalCode)).toBe(400);
    expect(workflowRefusalStatus("" as WorkflowRefusalCode)).toBe(400);
  });

  test("a prototype key is not mistaken for a mapped code", () => {
    // `toString` resolves on the prototype of a plain object literal, so a
    // naive lookup would return a function rather than falling through to
    // the 400 default.
    expect(workflowRefusalStatus("toString" as WorkflowRefusalCode)).toBe(400);
    expect(workflowRefusalStatus("constructor" as WorkflowRefusalCode)).toBe(400);
  });
});
