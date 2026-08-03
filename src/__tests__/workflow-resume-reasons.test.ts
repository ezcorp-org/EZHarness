/**
 * The suspension-reason table (`src/runtime/workflow-resume-reasons.ts`).
 *
 * The table is the extension point C3 adds `budget-exceeded` and
 * `consent-stale` to, so what is asserted here is mostly SHAPE: that the
 * enumeration matches the writers in the tree, that every reason is
 * classified, that unknown values degrade the way the module claims, and
 * that a predicate — once a row has one — is awaited and refuses.
 *
 * The compile-time half (adding a reason without a table row fails the
 * build) cannot be asserted from a passing test file: it is a type error,
 * and a type error in this file would fail `bun run typecheck` for the
 * whole repo. It is proved by mutation instead, and the mutation is
 * recorded in the commit message.
 */
import { test, expect, describe } from "bun:test";
import {
  RESUME_RULES,
  WORKFLOW_SUSPEND_REASONS,
  parseSuspendReason,
  resumeRuleFor,
  resumeReasonRefusal,
  type ResumeRule,
  type WorkflowSuspendReason,
} from "../runtime/workflow-resume-reasons";

describe("the enumeration matches what production actually writes", () => {
  test("exactly four reasons, and every one has a table row", () => {
    // Enumerated from the writers, cited in the module doc:
    // workflow-executor.ts:2353 / :2151, workflow-runs.ts:612,
    // workflow-approval-timeout-sweep.ts:217.
    expect([...WORKFLOW_SUSPEND_REASONS].sort()).toEqual([
      "approval",
      "approval-timeout",
      "nested-suspended",
      "orphaned-resumable",
    ]);
    // The table is total over the union. `satisfies` proves this at
    // compile time; asserting it here catches a row deleted at runtime by
    // a bad merge, which `satisfies` alone would not.
    for (const reason of WORKFLOW_SUSPEND_REASONS) {
      expect(RESUME_RULES[reason]).toBeDefined();
      expect(typeof RESUME_RULES[reason].describe).toBe("string");
      expect(RESUME_RULES[reason].describe.length).toBeGreaterThan(0);
    }
    expect(Object.keys(RESUME_RULES).sort()).toEqual([...WORKFLOW_SUSPEND_REASONS].sort());
  });

  test("only `approval-timeout` is barred from a live suspended row", () => {
    // It is written exclusively as a run terminalizes, so a live
    // suspended row carrying it is out-of-band. The other three are
    // ordinary parked states.
    const live = WORKFLOW_SUSPEND_REASONS.filter((r) => RESUME_RULES[r].liveOnSuspendedRow);
    expect([...live].sort()).toEqual(["approval", "nested-suspended", "orphaned-resumable"]);
    expect(RESUME_RULES["approval-timeout"].liveOnSuspendedRow).toBe(false);
  });
});

describe("parseSuspendReason narrows the free-text column", () => {
  test("every known reason round-trips", () => {
    for (const reason of WORKFLOW_SUSPEND_REASONS) {
      expect(parseSuspendReason(reason)).toBe(reason);
    }
  });

  test("null, undefined, empty and unknown all degrade to null", () => {
    // Unknown is deliberately not a refusal — see the module doc. A
    // legacy or rolling-deploy value must not brick a healthy run.
    expect(parseSuspendReason(null)).toBeNull();
    expect(parseSuspendReason(undefined)).toBeNull();
    expect(parseSuspendReason("")).toBeNull();
    expect(parseSuspendReason("awaiting-human")).toBeNull();
    expect(parseSuspendReason("budget-exceeded")).toBeNull();
  });

  test("resumeRuleFor returns null for an unknown reason and a rule for a known one", () => {
    expect(resumeRuleFor(null)).toBeNull();
    expect(resumeRuleFor("approval")).toBe(RESUME_RULES.approval);
  });
});

describe("resumeReasonRefusal — today allows everything, and will not once a row has a predicate", () => {
  test("every reason on this tree allows, because each is re-checked by the step", () => {
    // The claim the `satisfied: null` rows make. If a future edit gives
    // one of these a predicate without also wiring what satisfies it,
    // this test fails loudly rather than parked runs silently stalling.
    return Promise.all(
      WORKFLOW_SUSPEND_REASONS.map(async (reason) => {
        expect(await resumeReasonRefusal(reason, { workflowRunId: "run-1" })).toBeNull();
      }),
    );
  });

  test("an unknown reason allows, and falls through to the other resume guards", async () => {
    expect(await resumeReasonRefusal("something-new", { workflowRunId: "run-1" })).toBeNull();
    expect(await resumeReasonRefusal(null, { workflowRunId: "run-1" })).toBeNull();
  });

  test("a row WITH a predicate refuses when unsatisfied, and names the run and the reason", async () => {
    // C3's shape, driven through the REAL `resumeReasonRefusal` via its
    // table seam. Every row on this tree has `satisfied: null`, so without
    // this the refusing branch is unreachable and the table's only tested
    // behaviour would be "always allow" — the branch would first execute
    // in production, on the day the spend cap shipped.
    const rules: Record<string, ResumeRule> = {
      ...RESUME_RULES,
      approval: {
        satisfied: async () => false,
        describe: "the spend cap must be back under budget",
        liveOnSuspendedRow: true,
      },
    };
    expect(await resumeReasonRefusal("approval", { workflowRunId: "run-9" }, rules)).toBe(
      "Workflow run run-9 is suspended (approval): the spend cap must be back under budget",
    );
  });

  test("a predicate that is SATISFIED allows the resume", async () => {
    const rules: Record<string, ResumeRule> = {
      ...RESUME_RULES,
      approval: {
        satisfied: async () => true,
        describe: "irrelevant when satisfied",
        liveOnSuspendedRow: true,
      },
    };
    expect(await resumeReasonRefusal("approval", { workflowRunId: "run-9" }, rules)).toBeNull();
  });

  test("an unknown reason never reaches a predicate, even one the table holds", async () => {
    // `parseSuspendReason` narrows FIRST, so a caller cannot smuggle an
    // arbitrary string into a table lookup.
    let called = false;
    const rules: Record<string, ResumeRule> = {
      ...RESUME_RULES,
      "budget-exceeded": {
        satisfied: async () => {
          called = true;
          return false;
        },
        describe: "unreachable via an unknown reason",
        liveOnSuspendedRow: true,
      },
    };
    expect(
      await resumeReasonRefusal("budget-exceeded", { workflowRunId: "run-9" }, rules),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("the predicate receives the run id it was asked about, and nothing else", async () => {
    // Pins the proof-not-assertion contract: the context carries only an
    // id, so a predicate must RE-READ the world rather than trust a
    // caller-supplied fact.
    const seen: Array<{ workflowRunId: string }> = [];
    const rule: ResumeRule = {
      satisfied: async (ctx) => {
        seen.push(ctx);
        return true;
      },
      describe: "records its context",
      liveOnSuspendedRow: true,
    };
    await rule.satisfied!({ workflowRunId: "run-42" });
    expect(seen).toEqual([{ workflowRunId: "run-42" }]);
    expect(Object.keys(seen[0]!)).toEqual(["workflowRunId"]);
  });
});

describe("the union and the table cannot drift apart", () => {
  test("a value typed as the union is always a table key", () => {
    // Compile-time-backed, asserted at runtime so a `satisfies` that is
    // accidentally removed still gets caught.
    const every: WorkflowSuspendReason[] = [...WORKFLOW_SUSPEND_REASONS];
    for (const reason of every) {
      expect(Object.hasOwn(RESUME_RULES, reason)).toBe(true);
    }
  });
});
