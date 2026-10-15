import { expect, test } from "bun:test";
import { WORKFLOW_RELEASE_AUTHORITY_LOST } from "../../runtime/workflow-release-assets";
import {
  LEGACY_RELEASE_AUTHORITY_LOST_REASON,
  LEGACY_WORKFLOW_STATUS_SCHEMA_VERSION,
  legacyWorkflowIsResumable,
  legacyWorkflowIsTerminal,
  mapLegacyWorkflowStatus,
  type LegacyWorkflowRunFacts,
} from "./status";

const observedAtMs = Date.UTC(2030, 0, 1);

function facts(overrides: Partial<LegacyWorkflowRunFacts> = {}): LegacyWorkflowRunFacts {
  return {
    status: "running",
    runPhase: "boundary",
    suspendedReason: null,
    resumable: false,
    leaseExpiresAtMs: null,
    cursorBatchIndex: null,
    inFlightStepNames: [],
    resultErrorCode: null,
    resultErrorMessage: null,
    resultOutput: null,
    observedAtMs,
    ...overrides,
  };
}

test("`success` maps to succeeded and carries the referenced outputs", () => {
  const outcome = mapLegacyWorkflowStatus(facts({ status: "success", resultOutput: { report: "artifact:1" } }));
  expect(outcome).toEqual({ state: "succeeded", output: { report: "artifact:1" } });
  expect(legacyWorkflowIsTerminal(outcome)).toBe(true);
  expect(legacyWorkflowIsResumable(outcome)).toBe(false);
});

test("`suspended` maps to waiting with its reason, and only a resumable one may be resumed", () => {
  const parked = mapLegacyWorkflowStatus(facts({ status: "suspended", suspendedReason: "approval", resumable: false }));
  expect(parked).toEqual({ state: "waiting", reason: "approval", resumable: false });
  expect(legacyWorkflowIsResumable(parked)).toBe(false);
  expect(legacyWorkflowIsTerminal(parked)).toBe(false);

  const orphaned = mapLegacyWorkflowStatus(facts({ status: "suspended", suspendedReason: "orphaned-resumable", resumable: true }));
  expect(orphaned).toEqual({ state: "waiting", reason: "orphaned-resumable", resumable: true });
  expect(legacyWorkflowIsResumable(orphaned)).toBe(true);
});

test("a suspended run with no recorded reason still reports one", () => {
  expect(mapLegacyWorkflowStatus(facts({ status: "suspended", suspendedReason: null, resumable: true })))
    .toEqual({ state: "waiting", reason: "suspended", resumable: true });
});

test("`awaiting_approval` is terminal uncertainty, surfaced as a blocker and never resumable", () => {
  const outcome = mapLegacyWorkflowStatus(facts({ status: "awaiting_approval", resultErrorMessage: "step publish needs approval" }));
  expect(outcome).toEqual({ state: "uncertain", reason: "awaiting-approval", terminal: true, blocker: "step publish needs approval" });
  expect(legacyWorkflowIsTerminal(outcome)).toBe(true);
  expect(legacyWorkflowIsResumable(outcome)).toBe(false);

  expect(mapLegacyWorkflowStatus(facts({ status: "awaiting_approval" })))
    .toEqual({ state: "uncertain", reason: "awaiting-approval", terminal: true, blocker: "awaiting_approval" });
});

test("`running` with an expired lease is uncertain and NOT terminal; the sweep still owns it", () => {
  const outcome = mapLegacyWorkflowStatus(facts({ status: "running", leaseExpiresAtMs: observedAtMs - 1 }));
  expect(outcome).toEqual({ state: "uncertain", reason: "lease-expired", terminal: false, blocker: `lease expired at ${observedAtMs - 1}` });
  expect(legacyWorkflowIsTerminal(outcome)).toBe(false);
});

test("`running` inside its lease, and a lease-less run, are both plainly running", () => {
  expect(mapLegacyWorkflowStatus(facts({ status: "running", leaseExpiresAtMs: observedAtMs }))).toEqual({ state: "running" });
  expect(mapLegacyWorkflowStatus(facts({ status: "running", leaseExpiresAtMs: null }))).toEqual({ state: "running" });
});

test("a mid-batch orphan fails with the recorded batch index and in-flight step names", () => {
  const outcome = mapLegacyWorkflowStatus(facts({
    status: "error", runPhase: "in-batch", resumable: false, cursorBatchIndex: 3,
    inFlightStepNames: ["render", "publish"], resultErrorMessage: "Workflow run orphaned mid-batch (batch 3, steps in flight: publish, render)",
  }));
  expect(outcome).toEqual({
    state: "failed",
    reason: "Workflow run orphaned mid-batch (batch 3, steps in flight: publish, render)",
    batchIndex: 3,
    inFlightSteps: ["render", "publish"],
  });
  expect(legacyWorkflowIsTerminal(outcome)).toBe(true);
});

test("a run that lost release authority mid-flight maps to release-authority-lost through every shape the engine writes", () => {
  const bare = mapLegacyWorkflowStatus(facts({ status: "error", resultErrorMessage: WORKFLOW_RELEASE_AUTHORITY_LOST }));
  const coded = mapLegacyWorkflowStatus(facts({ status: "error", resultErrorCode: "release-unavailable", resultErrorMessage: WORKFLOW_RELEASE_AUTHORITY_LOST }));
  const resume = mapLegacyWorkflowStatus(facts({ status: "error", resultErrorCode: "not-resumable", resultErrorMessage: WORKFLOW_RELEASE_AUTHORITY_LOST }));

  for (const outcome of [bare, coded, resume]) {
    expect(outcome).toMatchObject({ state: "failed", reason: LEGACY_RELEASE_AUTHORITY_LOST_REASON });
  }
});

test("`not-resumable` for any other cause is not laundered into release-authority-lost", () => {
  expect(mapLegacyWorkflowStatus(facts({ status: "error", resultErrorCode: "not-resumable", resultErrorMessage: "the definition changed" })))
    .toMatchObject({ state: "failed", reason: "not-resumable" });
});

test("an error with neither a code nor a message still fails rather than reporting nothing", () => {
  expect(mapLegacyWorkflowStatus(facts({ status: "error" })))
    .toEqual({ state: "failed", reason: "error", batchIndex: null, inFlightSteps: [] });
});

test("`cancelled` maps to cancelled, with and without a recorded reason", () => {
  expect(mapLegacyWorkflowStatus(facts({ status: "cancelled", resultErrorMessage: "operator stopped it" })))
    .toEqual({ state: "cancelled", reason: "operator stopped it" });
  const bare = mapLegacyWorkflowStatus(facts({ status: "cancelled" }));
  expect(bare).toEqual({ state: "cancelled", reason: "cancelled" });
  expect(legacyWorkflowIsTerminal(bare)).toBe(true);
});

test("a status this mapping does not know is uncertain, never assumed benign", () => {
  const outcome = mapLegacyWorkflowStatus(facts({ status: "idle" }));
  expect(outcome).toEqual({ state: "uncertain", reason: "unrecognized-status", terminal: false, blocker: "idle" });
  expect(legacyWorkflowIsTerminal(outcome)).toBe(false);
  expect(legacyWorkflowIsResumable(outcome)).toBe(false);
});

test("the schema version is published so a stored outcome can name its shape", () => {
  expect(LEGACY_WORKFLOW_STATUS_SCHEMA_VERSION).toBe("factory.legacy-status.v1");
});
