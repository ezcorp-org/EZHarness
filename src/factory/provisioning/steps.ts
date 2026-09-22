/**
 * The seven C12 provisioning steps, their order, and what each one proves.
 *
 * C12 fixes the order and makes every step idempotent by tenant ID and
 * recorded. This module is the one statement of that order. The provisioner
 * walks it, the ledger stores one row per entry, and the operator API reports
 * it, so a step cannot be skipped, reordered, or reported under a second name.
 *
 * Four phases separate what the steps establish. They are different claims and
 * the code keeps them apart:
 *
 *   - `resources_prepared`: steps 1 to 4. Credentials exist and each one was
 *     verified against its own service. Nothing runs yet.
 *   - `deployment_ready`: steps 5 and 6. The installation's processes run and
 *     report ready, and its hostname is bound. The route is still HELD.
 *   - `invitation_issued`: step 7. A first-administrator invitation exists and
 *     the route serves. An invitation is not consent.
 *   - `bootstrap_complete`: observed, never performed. A human redeemed the
 *     invitation and gave explicit bootstrap consent inside the installation.
 *
 * A tenant in any earlier phase serves no traffic.
 */

export const FACTORY_INSTALLATION_PHASES = [
  "recorded",
  "resources_prepared",
  "deployment_ready",
  "invitation_issued",
  "bootstrap_complete",
  "tearing_down",
  "torn_down",
  "purged",
] as const;
export type FactoryInstallationPhase = typeof FACTORY_INSTALLATION_PHASES[number];

export const FACTORY_PROVISIONING_STEP_NAMES = ["database", "storage", "temporal", "secrets", "deployment", "ingress", "invitation"] as const;
export type FactoryProvisioningStepName = typeof FACTORY_PROVISIONING_STEP_NAMES[number];

export interface FactoryProvisioningStepSpec {
  readonly step: FactoryProvisioningStepName;
  readonly ordinal: number;
  /** The component that owns every resource this step creates. Teardown asks this owner, and only it. */
  readonly owner: string;
  /** The phase the installation reaches once this step and every earlier one is complete. */
  readonly completes: Extract<FactoryInstallationPhase, "resources_prepared" | "deployment_ready" | "invitation_issued"> | undefined;
  readonly description: string;
}

export const FACTORY_PROVISIONING_STEPS: readonly FactoryProvisioningStepSpec[] = Object.freeze([
  { step: "database", ordinal: 1, owner: "provisioner/postgres", completes: undefined, description: "PostgreSQL database and login role with a generated password" },
  { step: "storage", ordinal: 2, owner: "provisioner/object-store", completes: undefined, description: "Product object-store credential and a separately credentialed archive credential" },
  { step: "temporal", ordinal: 3, owner: "provisioner/temporal", completes: undefined, description: "Temporal namespace with namespace-scoped mutual-TLS credentials" },
  { step: "secrets", ordinal: 4, owner: "provisioner/secrets", completes: "resources_prepared", description: "Application JWT and encryption secrets and the wrapped data key" },
  { step: "deployment", ordinal: 5, owner: "provisioner/deployer", completes: undefined, description: "Harness, orchestration process, and gateway deployments" },
  { step: "ingress", ordinal: 6, owner: "provisioner/ingress", completes: "deployment_ready", description: "Trusted hostname bound to the installation ID" },
  { step: "invitation", ordinal: 7, owner: "provisioner/invitation", completes: "invitation_issued", description: "First-administrator invitation" },
].map((spec) => Object.freeze(spec as FactoryProvisioningStepSpec)));

export const FACTORY_STEP_STATES = ["pending", "running", "complete", "failed", "torn_down"] as const;
export type FactoryStepState = typeof FACTORY_STEP_STATES[number];

export interface FactoryStepFailure {
  readonly code: string;
  readonly message: string;
}

export class FactoryProvisioningError extends Error {
  constructor(readonly code: string, message: string, readonly step?: FactoryProvisioningStepName) {
    super(message);
    this.name = "FactoryProvisioningError";
  }
}

const FAILURE_MESSAGE_LIMIT = 512;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function factoryProvisioningStep(step: FactoryProvisioningStepName): FactoryProvisioningStepSpec {
  const spec = FACTORY_PROVISIONING_STEPS.find((candidate) => candidate.step === step);
  if (!spec) throw new FactoryProvisioningError("provisioning_step_unknown", `Unknown provisioning step ${String(step)}.`);
  return spec;
}

/**
 * The next step to run, given each step's recorded state.
 *
 * Steps complete strictly in order. A later step recorded complete while an
 * earlier one is not is a corrupt ledger, not a resumable one, and is refused
 * rather than skipped: resuming it would run step N+1's owner against a tenant
 * whose step N resources were never proven.
 */
export function nextFactoryProvisioningStep(states: Readonly<Partial<Record<FactoryProvisioningStepName, FactoryStepState>>>): FactoryProvisioningStepSpec | undefined {
  let next: FactoryProvisioningStepSpec | undefined;
  for (const spec of FACTORY_PROVISIONING_STEPS) {
    const state = states[spec.step] ?? "pending";
    if (state === "torn_down") throw new FactoryProvisioningError("provisioning_torn_down", "A torn-down installation cannot resume provisioning.", spec.step);
    if (state === "complete") {
      if (next) throw new FactoryProvisioningError("provisioning_ledger_out_of_order", `Step ${spec.step} is complete while ${next.step} is not.`, spec.step);
      continue;
    }
    next ??= spec;
  }
  return next;
}

/** The phase a set of step states establishes, before any human bootstrap is observed. */
export function factoryPhaseForSteps(states: Readonly<Partial<Record<FactoryProvisioningStepName, FactoryStepState>>>): Extract<FactoryInstallationPhase, "recorded" | "resources_prepared" | "deployment_ready" | "invitation_issued"> {
  const next = nextFactoryProvisioningStep(states);
  const completed = next === undefined ? FACTORY_PROVISIONING_STEPS : FACTORY_PROVISIONING_STEPS.filter((spec) => spec.ordinal < next.ordinal);
  const reached = [...completed].reverse().find((spec) => spec.completes !== undefined);
  return reached?.completes ?? "recorded";
}

/** Only an installation whose invitation exists may receive a request through its hostname. */
export function factoryPhaseServesTraffic(phase: FactoryInstallationPhase): boolean {
  return phase === "invitation_issued" || phase === "bootstrap_complete";
}

const PHASE_ORDER: Readonly<Record<FactoryInstallationPhase, number>> = Object.freeze(Object.fromEntries(FACTORY_INSTALLATION_PHASES.map((phase, index) => [phase, index])) as Record<FactoryInstallationPhase, number>);

/**
 * Whether an installation may move from one phase to another.
 *
 * Provisioning phases only advance, one or more at a time, because a rerun can
 * complete several steps. Bootstrap follows only an issued invitation. Teardown
 * may begin from any live phase, including a partial one, and purge follows only
 * a finished teardown. Nothing leaves `purged`.
 */
export function factoryPhaseTransitionAllowed(from: FactoryInstallationPhase, to: FactoryInstallationPhase): boolean {
  if (from === to) return true;
  if (from === "purged") return false;
  if (to === "tearing_down") return from !== "torn_down";
  if (to === "torn_down") return from === "tearing_down";
  if (to === "purged") return from === "torn_down";
  if (from === "tearing_down" || from === "torn_down") return false;
  if (to === "bootstrap_complete") return from === "invitation_issued";
  return PHASE_ORDER[to] > PHASE_ORDER[from];
}

/**
 * A failure as the ledger records it.
 *
 * The code is a stable identifier an operator can act on. The message is
 * bounded and stripped of control characters; the provisioner never passes a
 * credential into an error, and this is the last place that could stop one
 * reaching a durable row if it did.
 */
export function factoryStepFailure(error: unknown): FactoryStepFailure {
  const code = error instanceof FactoryProvisioningError && FAILURE_CODE.test(error.code) ? error.code : "provisioning_step_failed";
  const raw = error instanceof Error ? error.message : String(error);
  const message = [...raw].map((character) => (character.codePointAt(0)! < 32 ? " " : character)).join("").slice(0, FAILURE_MESSAGE_LIMIT);
  return Object.freeze({ code, message: message || code });
}

export function isFactoryInstallationPhase(value: unknown): value is FactoryInstallationPhase {
  return typeof value === "string" && (FACTORY_INSTALLATION_PHASES as readonly string[]).includes(value);
}

export function isFactoryStepState(value: unknown): value is FactoryStepState {
  return typeof value === "string" && (FACTORY_STEP_STATES as readonly string[]).includes(value);
}
