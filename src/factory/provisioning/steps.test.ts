import { describe, expect, test } from "bun:test";
import {
  FACTORY_INSTALLATION_PHASES,
  FACTORY_PROVISIONING_STEP_NAMES,
  FACTORY_PROVISIONING_STEPS,
  FACTORY_STEP_STATES,
  FactoryProvisioningError,
  factoryPhaseForSteps,
  factoryPhaseServesTraffic,
  factoryPhaseTransitionAllowed,
  factoryProvisioningStep,
  factoryStepFailure,
  isFactoryInstallationPhase,
  isFactoryStepState,
  nextFactoryProvisioningStep,
  type FactoryInstallationPhase,
  type FactoryProvisioningStepName,
  type FactoryStepState,
} from "./steps";

type States = Partial<Record<FactoryProvisioningStepName, FactoryStepState>>;

function completeThrough(count: number): States {
  return Object.fromEntries(FACTORY_PROVISIONING_STEP_NAMES.slice(0, count).map((step) => [step, "complete"])) as States;
}

function caught(work: () => unknown): FactoryProvisioningError {
  try { work(); }
  catch (error) {
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    return error as FactoryProvisioningError;
  }
  throw new Error("expected a FactoryProvisioningError");
}

describe("step table", () => {
  test("lists the seven C12 steps in order with ordinals 1..7 and one owner each", () => {
    expect(FACTORY_PROVISIONING_STEPS.map((spec) => spec.step)).toEqual([...FACTORY_PROVISIONING_STEP_NAMES]);
    expect(FACTORY_PROVISIONING_STEPS.map((spec) => spec.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(FACTORY_PROVISIONING_STEPS.map((spec) => spec.owner)).size).toBe(7);
    expect(FACTORY_PROVISIONING_STEPS.filter((spec) => spec.completes).map((spec) => [spec.step, spec.completes])).toEqual([
      ["secrets", "resources_prepared"], ["ingress", "deployment_ready"], ["invitation", "invitation_issued"],
    ]);
  });

  test("the table and each entry are frozen", () => {
    expect(Object.isFrozen(FACTORY_PROVISIONING_STEPS)).toBe(true);
    expect(FACTORY_PROVISIONING_STEPS.every((spec) => Object.isFrozen(spec))).toBe(true);
  });

  test("factoryProvisioningStep returns the spec by name", () => {
    for (const name of FACTORY_PROVISIONING_STEP_NAMES) expect(factoryProvisioningStep(name).step).toBe(name);
    expect(factoryProvisioningStep("ingress").ordinal).toBe(6);
  });

  test("factoryProvisioningStep refuses an unknown step with a stable code", () => {
    const error = caught(() => factoryProvisioningStep("dns" as FactoryProvisioningStepName));
    expect(error.code).toBe("provisioning_step_unknown");
    expect(error.name).toBe("FactoryProvisioningError");
    expect(error.message).toContain("dns");
    expect(error.step).toBeUndefined();
  });
});

describe("nextFactoryProvisioningStep", () => {
  test("an empty ledger starts at step 1", () => {
    expect(nextFactoryProvisioningStep({})?.step).toBe("database");
  });

  test("each prefix of complete steps resumes at the following step", () => {
    for (let count = 0; count < 7; count += 1) expect(nextFactoryProvisioningStep(completeThrough(count))?.ordinal).toBe(count + 1);
  });

  test("a fully complete ledger has no next step", () => {
    expect(nextFactoryProvisioningStep(completeThrough(7))).toBeUndefined();
  });

  test("running and failed steps are resumed, not skipped", () => {
    expect(nextFactoryProvisioningStep({ ...completeThrough(2), temporal: "failed" })?.step).toBe("temporal");
    expect(nextFactoryProvisioningStep({ ...completeThrough(3), secrets: "running" })?.step).toBe("secrets");
  });

  test("a later step complete while an earlier one is not is refused as out of order", () => {
    const error = caught(() => nextFactoryProvisioningStep({ database: "complete", storage: "failed", temporal: "complete" }));
    expect(error.code).toBe("provisioning_ledger_out_of_order");
    expect(error.step).toBe("temporal");
    expect(error.message).toContain("storage");
  });

  test("a torn-down step refuses any resume", () => {
    const error = caught(() => nextFactoryProvisioningStep({ ...completeThrough(4), deployment: "torn_down" }));
    expect(error.code).toBe("provisioning_torn_down");
    expect(error.step).toBe("deployment");
  });
});

describe("factoryPhaseForSteps", () => {
  test("maps each completed prefix to the phase it proves", () => {
    const expected: ReturnType<typeof factoryPhaseForSteps>[] = ["recorded", "recorded", "recorded", "recorded", "resources_prepared", "resources_prepared", "deployment_ready", "invitation_issued"];
    for (let count = 0; count <= 7; count += 1) expect(factoryPhaseForSteps(completeThrough(count))).toBe(expected[count]!);
  });

  test("propagates an out-of-order refusal", () => {
    expect(caught(() => factoryPhaseForSteps({ invitation: "complete" })).code).toBe("provisioning_ledger_out_of_order");
  });
});

describe("factoryPhaseServesTraffic", () => {
  test("only invitation_issued and bootstrap_complete serve", () => {
    const serving = FACTORY_INSTALLATION_PHASES.filter((phase) => factoryPhaseServesTraffic(phase));
    expect(serving).toEqual(["invitation_issued", "bootstrap_complete"]);
  });
});

describe("factoryPhaseTransitionAllowed", () => {
  const allowed = (from: FactoryInstallationPhase, to: FactoryInstallationPhase) => factoryPhaseTransitionAllowed(from, to);

  test("staying in place is always allowed, even in purged", () => {
    for (const phase of FACTORY_INSTALLATION_PHASES) expect(allowed(phase, phase)).toBe(true);
  });

  test("nothing leaves purged", () => {
    for (const phase of FACTORY_INSTALLATION_PHASES.filter((candidate) => candidate !== "purged")) expect(allowed("purged", phase)).toBe(false);
  });

  test("teardown begins from any live phase but not from torn_down", () => {
    for (const phase of ["recorded", "resources_prepared", "deployment_ready", "invitation_issued", "bootstrap_complete"] as const) expect(allowed(phase, "tearing_down")).toBe(true);
    expect(allowed("torn_down", "tearing_down")).toBe(false);
  });

  test("torn_down follows only tearing_down; purged follows only torn_down", () => {
    expect(allowed("tearing_down", "torn_down")).toBe(true);
    expect(allowed("invitation_issued", "torn_down")).toBe(false);
    expect(allowed("torn_down", "purged")).toBe(true);
    expect(allowed("tearing_down", "purged")).toBe(false);
    expect(allowed("recorded", "purged")).toBe(false);
  });

  test("a teardown phase cannot return to provisioning", () => {
    expect(allowed("tearing_down", "recorded")).toBe(false);
    expect(allowed("torn_down", "invitation_issued")).toBe(false);
  });

  test("bootstrap follows only an issued invitation", () => {
    expect(allowed("invitation_issued", "bootstrap_complete")).toBe(true);
    expect(allowed("deployment_ready", "bootstrap_complete")).toBe(false);
    expect(allowed("recorded", "bootstrap_complete")).toBe(false);
  });

  test("provisioning phases advance one or several at a time and never retreat", () => {
    expect(allowed("recorded", "resources_prepared")).toBe(true);
    expect(allowed("recorded", "invitation_issued")).toBe(true);
    expect(allowed("deployment_ready", "resources_prepared")).toBe(false);
    expect(allowed("bootstrap_complete", "invitation_issued")).toBe(false);
  });
});

describe("factoryStepFailure", () => {
  test("keeps a well-formed FactoryProvisioningError code and message", () => {
    const failure = factoryStepFailure(new FactoryProvisioningError("database_unreachable", "PostgreSQL refused.", "database"));
    expect(failure).toEqual({ code: "database_unreachable", message: "PostgreSQL refused." });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  test("replaces a malformed code with the generic code", () => {
    expect(factoryStepFailure(new FactoryProvisioningError("Bad-Code", "x")).code).toBe("provisioning_step_failed");
    expect(factoryStepFailure(new FactoryProvisioningError(`a${"b".repeat(64)}`, "x")).code).toBe("provisioning_step_failed");
    expect(factoryStepFailure(new FactoryProvisioningError(`a${"b".repeat(63)}`, "x")).code).toBe(`a${"b".repeat(63)}`);
  });

  test("a plain Error or a non-Error value uses the generic code", () => {
    expect(factoryStepFailure(new Error("boom"))).toEqual({ code: "provisioning_step_failed", message: "boom" });
    expect(factoryStepFailure("text failure")).toEqual({ code: "provisioning_step_failed", message: "text failure" });
    expect(factoryStepFailure(42)).toEqual({ code: "provisioning_step_failed", message: "42" });
  });

  test("scrubs URLs, JWTs, bearer values, and named secret values a third-party message echoes", () => {
    const failure = factoryStepFailure(new Error("connect postgres://factory:hunter2@127.0.0.1:5432/db failed; Authorization: Bearer abc.def; jwt eyJhbGciOi.eyJzdWIi.c2ln; password=hunter2 secret: 'x y' token=\"q r\" KEY=k1"));
    expect(failure.message).toBe("connect <url> failed; Authorization: Bearer <redacted> jwt <token>; password=<redacted> secret: <redacted> token=<redacted> KEY=<redacted>");
    expect(failure.message).not.toContain("hunter2");
  });

  test("replaces control characters with spaces", () => {
    expect(factoryStepFailure(new Error("line1\nline2\t\u0000end")).message).toBe("line1 line2  end");
  });

  test("bounds the message at 512 characters", () => {
    expect(factoryStepFailure(new Error("x".repeat(512))).message).toHaveLength(512);
    expect(factoryStepFailure(new Error("x".repeat(2_000))).message).toHaveLength(512);
  });

  test("an empty message falls back to the code", () => {
    expect(factoryStepFailure(new FactoryProvisioningError("storage_denied", "")).message).toBe("storage_denied");
    expect(factoryStepFailure(new Error("")).message).toBe("provisioning_step_failed");
  });
});

describe("type guards", () => {
  test("isFactoryInstallationPhase accepts only listed phases", () => {
    for (const phase of FACTORY_INSTALLATION_PHASES) expect(isFactoryInstallationPhase(phase)).toBe(true);
    for (const value of ["", "Recorded", "complete", 1, null, undefined, {}]) expect(isFactoryInstallationPhase(value)).toBe(false);
  });

  test("isFactoryStepState accepts only listed states", () => {
    for (const state of FACTORY_STEP_STATES) expect(isFactoryStepState(state)).toBe(true);
    for (const value of ["", "done", "recorded", 0, null, undefined, []]) expect(isFactoryStepState(value)).toBe(false);
  });
});
