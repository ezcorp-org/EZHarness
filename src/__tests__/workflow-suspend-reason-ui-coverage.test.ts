/**
 * The browser's suspend-reason classifier must cover the vocabulary the
 * server actually writes — all of it, and only it.
 *
 * ## Why this test exists, and why it lives on the BACKEND side
 *
 * `describeRunStopReason` (`web/src/lib/workflow-delegations-logic.ts`)
 * shipped keying on `run.error` and matching `DELEGATION_*` deny codes as
 * substrings. **Every one of its five branches was unreachable on
 * production data**, and nothing caught it for eight phases:
 *
 *   - rungs D7-D10 are dispatch-time `denyAs(...)` RETURNS that create no
 *     `workflow_runs` row at all, so no run ever carries those codes;
 *   - the only two paths that leave a row write `suspended_reason`, never
 *     an error — `"consent-stale"` (`extensions/workflows-handler.ts:1765`)
 *     and `"budget-exceeded"` (`runtime/workflow-executor.ts:664`).
 *
 * The unit tests passed the whole time because they called the function
 * with hand-written strings that no server emits. That is the defect this
 * file makes unrepeatable: it does not invent an input. It takes the
 * CANONICAL vocabulary — {@link WORKFLOW_SUSPEND_REASONS}, which the
 * `satisfies Record<WorkflowSuspendReason, ResumeRule>` table already
 * forces to stay total — and requires the UI to have a sentence for every
 * member. Add a seventh reason without teaching the UI about it and this
 * fails.
 *
 * It is a BUN test rather than a vitest one because the canonical list
 * lives in `src/` and importing it pulls the db query module's chain,
 * which vitest's jsdom environment does not carry. The web module under
 * test is plain TypeScript with no Svelte and no browser globals at
 * import time, so bun can import it directly. `route-contract.test.ts` is
 * the precedent for a backend meta-test reaching into `web/`.
 */
import { test, expect, describe } from "bun:test";
import { WORKFLOW_SUSPEND_REASONS } from "../runtime/workflow-resume-reasons";
import { describeRunStopReason } from "../../web/src/lib/workflow-delegations-logic";

describe("describeRunStopReason covers every WorkflowSuspendReason", () => {
  test("every canonical reason gets a sentence — none falls through to the raw slug", () => {
    // The list is derived, never retyped: a copy here would drift exactly
    // the way the classifier drifted from the wire.
    const unexplained = WORKFLOW_SUSPEND_REASONS.filter(
      (reason) => describeRunStopReason(reason) === null,
    );
    expect(unexplained).toEqual([]);
  });

  test("each reason's sentence is DISTINCT — two reasons never read alike", () => {
    // `budget-exceeded` and `consent-stale` have opposite remedies (raise a
    // number here vs. re-open the consent dialog), and the original point of
    // this function was telling them apart. Collapsing any two into one
    // string would silently undo that.
    const sentences = WORKFLOW_SUSPEND_REASONS.map((r) => describeRunStopReason(r));
    expect(new Set(sentences).size).toBe(WORKFLOW_SUSPEND_REASONS.length);
  });

  test("every sentence is prose a person can act on, not a slug echo", () => {
    // Guards the lazy fix for the test above: returning the reason itself
    // would make every sentence distinct and non-null while explaining
    // nothing.
    const slugEchoes = WORKFLOW_SUSPEND_REASONS.filter((reason) => {
      const text = describeRunStopReason(reason) ?? "";
      return text.length < 30 || text === reason;
    });
    expect(slugEchoes).toEqual([]);
  });

  test("a DELEGATION_* deny code is NOT classified — it never reaches this field", () => {
    // The dispatch-time codes the dead implementation used to match. They
    // are emitted by `denyAs` and land in an audit row, never on a run, so
    // classifying one again would mean the function had been re-keyed onto
    // a field the server does not populate.
    const wronglyClassified = [
      "DELEGATION_DAILY_TOKENS_EXCEEDED",
      "DELEGATION_SPEND_EXCEEDED",
      "DELEGATION_QUOTA_EXCEEDED",
      "DELEGATION_CONSENT_STALE",
      "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS",
    ].filter((code) => describeRunStopReason(code) !== null);
    expect(wronglyClassified).toEqual([]);
  });

  test("an unknown reason returns null so the caller can show the raw value", () => {
    expect(describeRunStopReason("reason-from-a-newer-build")).toBeNull();
    expect(describeRunStopReason(null)).toBeNull();
  });
});
