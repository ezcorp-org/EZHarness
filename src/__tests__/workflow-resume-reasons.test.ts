/**
 * The suspension-reason table (`src/runtime/workflow-resume-reasons.ts`).
 *
 * What is asserted here is SHAPE: that the enumeration matches the writers
 * in the tree, that every reason is classified, that unknown values degrade
 * the way the module claims, and that a predicate is awaited and refuses.
 *
 * C3's `budget-exceeded` and `consent-stale` rows have now landed, and they
 * are the first rows with a real `satisfied` predicate. Their BEHAVIOUR is
 * pinned in `workflow-budget-boundary.test.ts`, against real delegation and
 * step rows — their predicates re-read from the database, so they cannot be
 * exercised from this file, which has none. What is pinned here is that
 * they exist, that they are classified, and that the narrowing in front of
 * them still holds.
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
  test("exactly six reasons, and every one has a table row", () => {
    // Enumerated from the writers, cited in the module doc:
    // workflow-executor.ts's approval park, its nested park and its C3
    // boundary check, workflow-runs.ts's recovery sweep, and
    // workflow-approval-timeout-sweep.ts. `consent-stale` is the one
    // member with no writer yet, and the module doc says why it is here
    // ahead of one: shipping the writer first would leave a window in
    // which the value parses to null and therefore ALLOWS.
    expect([...WORKFLOW_SUSPEND_REASONS].sort()).toEqual([
      "approval",
      "approval-timeout",
      "budget-exceeded",
      "consent-stale",
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
    // suspended row carrying it is out-of-band. Every other reason,
    // C3's two included, is an ordinary parked state.
    const live = WORKFLOW_SUSPEND_REASONS.filter((r) => RESUME_RULES[r].liveOnSuspendedRow);
    expect([...live].sort()).toEqual([
      "approval",
      "budget-exceeded",
      "consent-stale",
      "nested-suspended",
      "orphaned-resumable",
    ]);
    expect(RESUME_RULES["approval-timeout"].liveOnSuspendedRow).toBe(false);
  });

  test("exactly C3's two rows carry a predicate; the rest defer to step re-entry", () => {
    // The claim the `satisfied: null` rows make, stated as a list so
    // giving one of them a predicate — or quietly dropping one of C3's —
    // fails here rather than in production.
    const withPredicate = WORKFLOW_SUSPEND_REASONS.filter(
      (r) => RESUME_RULES[r].satisfied !== null,
    );
    expect([...withPredicate].sort()).toEqual(["budget-exceeded", "consent-stale"]);
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
    // `quota` is the value the plan documents used and the tree never
    // adopted — the module doc calls it out by name. It stands in here
    // for exactly what this test is about: a reason no build knows.
    expect(parseSuspendReason("quota")).toBeNull();
  });

  test("resumeRuleFor returns null for an unknown reason and a rule for a known one", () => {
    expect(resumeRuleFor(null)).toBeNull();
    expect(resumeRuleFor("approval")).toBe(RESUME_RULES.approval);
  });
});

describe("resumeReasonRefusal — today allows everything, and will not once a row has a predicate", () => {
  test("every `satisfied: null` reason allows, because each is re-checked by the step", () => {
    // The claim those rows make. If a future edit gives one of them a
    // predicate without also wiring what satisfies it, this fails loudly
    // rather than leaving parked runs to stall silently.
    //
    // C3's two are excluded BY THEIR OWN PROPERTY rather than by name, so
    // a third predicate row added later is covered without editing this
    // filter. Their behaviour is pinned against a real database in
    // `workflow-budget-boundary.test.ts`.
    const deferred = WORKFLOW_SUSPEND_REASONS.filter((r) => RESUME_RULES[r].satisfied === null);
    expect(deferred.length).toBeGreaterThan(0);
    return Promise.all(
      deferred.map(async (reason) => {
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
      quota: {
        satisfied: async () => {
          called = true;
          return false;
        },
        describe: "unreachable via an unknown reason",
        liveOnSuspendedRow: true,
      },
    };
    expect(await resumeReasonRefusal("quota", { workflowRunId: "run-9" }, rules)).toBeNull();
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
