/**
 * The collaborators a later work package owns, named and typed at the seam.
 *
 * Composition happens before every package has landed, and the tempting shape
 * is a placeholder that returns a plausible value. That is the one shape this
 * file exists to forbid: a stop that reports `stopped` without observing a
 * stopped process, or a release profile that returns an empty destination, is
 * a durable false fact, and the plan rules such a fact out explicitly.
 *
 * So an absent collaborator is not an empty implementation. It is a seam that
 * knows its own name and its owning package, answers `present === false`, and
 * throws a typed refusal naming the package when anything asks it to act. A
 * worker whose seam is absent holds its queue rather than draining it into a
 * fabricated outcome, and the held reason is visible in the runtime's state.
 */

export class FactorySeamUnavailableError extends Error {
  readonly code = "factory_seam_unavailable";
  constructor(readonly seam: string, readonly workPackage: string) {
    super(`Factory seam '${seam}' is not composed; it is delivered by ${workPackage}.`);
    this.name = "FactorySeamUnavailableError";
  }
}

export interface FactorySeamState {
  readonly seam: string;
  readonly workPackage: string;
  readonly present: boolean;
}

export interface FactorySeam<Value> extends FactorySeamState {
  /** The collaborator, or a typed refusal naming the package that owns it. */
  require(): Value;
  /** The collaborator when composed, so a worker can hold instead of throwing. */
  optional(): Value | undefined;
}

export function factorySeam<Value>(seam: string, workPackage: string, value?: Value): FactorySeam<Value> {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(seam)) throw new Error("a factory seam name must be a lowercase dashed identifier");
  if (!/^W[0-9]{2}[a-z]?(\/W[0-9]{2}[a-z]?)*$/.test(workPackage)) throw new Error("a factory seam must name its owning work package");
  return Object.freeze({
    seam,
    workPackage,
    present: value !== undefined,
    require(): Value {
      if (value === undefined) throw new FactorySeamUnavailableError(seam, workPackage);
      return value;
    },
    optional: () => value,
  });
}

/**
 * One bounded step, which is what a background role actually needs.
 *
 * The freeze names the collaborator types the owning packages deliver —
 * `FactoryPhysicalStopper` (section 3), `FactoryUsageReconciler` (section 4),
 * `FactoryAsyncReleaseProfile` (section 5). None of them is a loop: each acts on
 * one exact operation a caller already identified. A worker also needs the half
 * that finds the next operation to act on, and that half reads the owning
 * package's tables. So the seam is the composed step, and the owning package
 * adapts its collaborator plus its own scan into it. That keeps a lifecycle
 * query in the file that owns the lifecycle instead of in this composition root.
 */
export interface FactoryRoleDriver {
  /** Resolves true when it did work, false when there was none. */
  step(signal: AbortSignal): Promise<boolean>;
}

/**
 * Everything the composition consumes that W09 does not own.
 *
 * Five of these drive a background role and five are collaborators the release
 * store needs before it can be constructed at all.
 */
export interface FactoryRuntimeSeamInputs {
  /** W03 — settles a stop against a signed physical-stop receipt. */
  readonly physicalStopper?: FactoryRoleDriver;
  /** W03 — settles an operation whose cost was unknown, never as zero. */
  readonly usageReconciler?: FactoryRoleDriver;
  /** W05/W06 — settles a child run its parent has not yet settled. */
  readonly childSettlement?: FactoryRoleDriver;
  /** W07/W08 — claims and dispatches the next release operation. */
  readonly releaseProviders?: FactoryRoleDriver;
  /** W17 — delivers a notification off this host and confirms it left. */
  readonly notificationSender?: FactoryRoleDriver;
  /** W05 — the trusted validator gateway `FactoryAssurance` requires. */
  readonly validatorGateway?: unknown;
  /** W05 — the release fence reader `FactoryAssurance` requires. */
  readonly releaseFenceReader?: unknown;
  /** W05 — the current-candidate resolver `FactoryAssurance` requires. */
  readonly currentCandidate?: unknown;
  /** W07/W08 — destination reservation for a release operation. */
  readonly destinations?: unknown;
  /** W07/W08 — the sender fence proving a stopped sender before reconciliation. */
  readonly senderFence?: unknown;
}

export interface FactoryRuntimeSeams {
  readonly physicalStopper: FactorySeam<FactoryRoleDriver>;
  readonly usageReconciler: FactorySeam<FactoryRoleDriver>;
  readonly childSettlement: FactorySeam<FactoryRoleDriver>;
  readonly releaseProviders: FactorySeam<FactoryRoleDriver>;
  readonly notificationSender: FactorySeam<FactoryRoleDriver>;
  readonly validatorGateway: FactorySeam<unknown>;
  readonly releaseFenceReader: FactorySeam<unknown>;
  readonly currentCandidate: FactorySeam<unknown>;
  readonly destinations: FactorySeam<unknown>;
  readonly senderFence: FactorySeam<unknown>;
}

const SEAM_OWNERS: Readonly<Record<keyof FactoryRuntimeSeams, { readonly seam: string; readonly workPackage: string }>> = Object.freeze({
  physicalStopper: { seam: "physical-stopper", workPackage: "W03" },
  usageReconciler: { seam: "usage-reconciler", workPackage: "W03" },
  childSettlement: { seam: "child-settlement", workPackage: "W06" },
  releaseProviders: { seam: "release-providers", workPackage: "W07/W08" },
  notificationSender: { seam: "notification-sender", workPackage: "W17" },
  validatorGateway: { seam: "validator-gateway", workPackage: "W05" },
  releaseFenceReader: { seam: "release-fence-reader", workPackage: "W05" },
  currentCandidate: { seam: "current-candidate", workPackage: "W05" },
  destinations: { seam: "destination-reservations", workPackage: "W07/W08" },
  senderFence: { seam: "sender-fence", workPackage: "W07/W08" },
});

export function factoryRuntimeSeams(inputs: FactoryRuntimeSeamInputs = {}): FactoryRuntimeSeams {
  const built = {} as Record<keyof FactoryRuntimeSeams, FactorySeam<unknown>>;
  for (const [key, owner] of Object.entries(SEAM_OWNERS) as Array<[keyof FactoryRuntimeSeams, { seam: string; workPackage: string }]>) {
    built[key] = factorySeam(owner.seam, owner.workPackage, inputs[key]);
  }
  return Object.freeze(built) as unknown as FactoryRuntimeSeams;
}

/** Every seam's verdict, for the runtime's readiness report and its evidence. */
export function factorySeamStates(seams: FactoryRuntimeSeams): readonly FactorySeamState[] {
  return Object.freeze(Object.values(seams).map(({ seam, workPackage, present }) => Object.freeze({ seam, workPackage, present })));
}

/** The seams a release store needs before it can be composed at all. */
export const FACTORY_RELEASE_SEAMS = Object.freeze(["validatorGateway", "releaseFenceReader", "currentCandidate", "destinations", "senderFence"] as const);

export function factoryReleaseSeamsPresent(seams: FactoryRuntimeSeams): boolean {
  return FACTORY_RELEASE_SEAMS.every((key) => seams[key].present);
}
