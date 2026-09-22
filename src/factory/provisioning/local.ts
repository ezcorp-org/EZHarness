/**
 * The C12 provisioner: one code path for every installation, hosted or
 * self-hosted, walking the seven steps in order.
 *
 * This extends the v1 provisioner rather than standing beside it: the same
 * `factory_installations` ledger, the same per-tenant advisory lock, the same
 * crash-recoverable database step (now `database.ts`), and the same rule that
 * a resource is adopted only with this installation's recorded provenance.
 * What v1 called `ready` — "its infrastructure resources exist" — is now the
 * first of four separate phases (`steps.ts`), and the six steps v1 did not
 * have are drivers the deployment profile supplies.
 *
 * Failure is recorded, never swallowed. A step that throws is written `failed`
 * with its code and message on the ledger's own connection, so the record
 * outlives the fault; the next `provision` resumes at that step, and every
 * completed step before it is re-verified against its live service first. A
 * partial installation's route stays held, so it serves no traffic.
 */
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { FactoryProvisioningLedger, type FactoryInstallationRecord, type FactoryStepRecord } from "./ledger";
import { assertFactoryInstallationRequest, factoryInstallationNames, type FactoryInstallationContext, type FactoryInstallationRequest, type FactoryProvisioningDriver, type FactoryStepResources } from "./installation";
import { escrowFactoryArchiveKey } from "./secrets";
import { FACTORY_PROVISIONING_STEPS, FactoryProvisioningError, factoryPhaseServesTraffic, factoryStepFailure, type FactoryInstallationPhase, type FactoryProvisioningStepName, type FactoryStepFailure } from "./steps";

/** v1 names, kept so existing callers still compile against the extended provisioner. */
export type LocalInstallationRequest = FactoryInstallationRequest;

export interface FactoryIngressDriver extends FactoryProvisioningDriver {
  readonly step: "ingress";
  serve(installation: FactoryInstallationContext): Promise<void>;
  hold(installation: FactoryInstallationContext): Promise<void>;
}

export interface FactoryPurgeableDriver extends FactoryProvisioningDriver {
  purge(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void>;
}

/** Step 5 also re-delivers every file the other steps hand to a running service, and rotates the mesh. */
export interface FactoryDeploymentDriver extends FactoryPurgeableDriver {
  readonly step: "deployment";
  redeliver(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void>;
  rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources>;
}

export interface FactoryProvisioningDrivers {
  readonly database: FactoryPurgeableDriver & { readonly step: "database" };
  readonly storage: FactoryProvisioningDriver & { readonly step: "storage" };
  readonly temporal: FactoryProvisioningDriver & { readonly step: "temporal" };
  readonly secrets: FactoryProvisioningDriver & { readonly step: "secrets" };
  readonly deployment: FactoryDeploymentDriver;
  readonly ingress: FactoryIngressDriver;
  readonly invitation: FactoryProvisioningDriver & { readonly step: "invitation" };
}

/** What a human bootstrap looks like from outside the installation: routing and membership facts only. */
export interface FactoryBootstrapObservation { readonly complete: boolean; readonly invitationId?: string }
export interface FactoryBootstrapObserver { observe(installation: FactoryInstallationContext): Promise<FactoryBootstrapObservation> }

/** Aggregate counts of work that must close before a purge. Counts only; never a product fact. */
export interface FactoryWorkCensus { count(installation: FactoryInstallationContext): Promise<{ readonly active: number; readonly uncertain: number }> }

export interface LocalProvisionerOptions {
  readonly fleetId: string;
  readonly controlDatabaseUrl: string;
  readonly secretsRoot: string;
  readonly operatorRoot: string;
  readonly drivers: FactoryProvisioningDrivers;
  /** Fault injection: throw from here to fail a step before or after its effect. Tests only. */
  readonly fault?: (step: FactoryProvisioningStepName, point: "before" | "after") => Promise<void>;
}

export interface LocalInstallation {
  readonly tenantId: string;
  readonly installationId: string;
  readonly hostname: string;
  readonly phase: FactoryInstallationPhase;
  readonly productDatabase: string;
  readonly productRole: string;
  readonly temporalNamespace: string;
  readonly secretBundlePath: string;
  readonly steps: readonly FactoryStepRecord[];
  /** v1 compatibility: `ready` once the resources exist, `partial` before. */
  readonly state: "ready" | "partial";
}

export interface FactoryTeardownOutcome {
  readonly installation: LocalInstallation;
  /** Steps whose teardown completed everything it could but left a named residue, e.g. an unrevocable seeded store identity. */
  readonly residues: readonly { readonly step: FactoryProvisioningStepName; readonly failure: FactoryStepFailure }[];
}

/**
 * A purge approval the installation itself issued to an administrator's
 * session (`purge-approval.ts`). The operator names it; the provisioner reads
 * it from the retained product database. The operator cannot mint one.
 */
export interface FactoryPurgeRequest {
  readonly approvalId: string;
  readonly reason: string;
}

export interface FactoryVerifiedPurgeApproval {
  /** The approving administrator's membership reference, `admin:<email>`. */
  readonly approvedBy: string;
}

export interface FactoryPurgeApprovals { verify(installation: FactoryInstallationContext, approvalId: string): Promise<FactoryVerifiedPurgeApproval> }

/** What must hold before a purge: closed work and an installation-issued approval. */
export interface FactoryPurgeChecks {
  readonly census: FactoryWorkCensus;
  readonly approvals: FactoryPurgeApprovals;
}

/** Who asked for an operation: a named operator certificate, or the local operator account. Recorded on the ledger. */
export interface FactoryOperationActor { readonly actor?: string }

/** What purge cannot remove on this host, stated in the audit-loss record rather than implied. */
export const FACTORY_PURGE_RETAINED = Object.freeze({
  releaseArchive: "retained",
  archiveKeyEscrow: "retained",
  temporalNamespaceHistory: "retained_until_namespace_retention",
  ordinaryObjects: "retained_storage_revocation_unsupported",
});

const PHASE_RANK: Readonly<Record<FactoryInstallationPhase, number>> = { recorded: 0, resources_prepared: 1, deployment_ready: 2, invitation_issued: 3, bootstrap_complete: 4, tearing_down: 5, torn_down: 6, purged: 7 };

export class LocalFactoryProvisioner {
  readonly ledger: FactoryProvisioningLedger;
  private readonly control: SQL;
  constructor(private readonly options: LocalProvisionerOptions) {
    this.control = new SQL(options.controlDatabaseUrl, { max: 8 });
    this.ledger = new FactoryProvisioningLedger(this.control);
  }

  async close(): Promise<void> { await this.control.close(); }
  async setup(): Promise<void> { await this.ledger.setup(); }

  private driver(step: FactoryProvisioningStepName): FactoryProvisioningDriver {
    const driver = this.options.drivers[step];
    if (driver.step !== step) throw new FactoryProvisioningError("provisioning_driver_mismatch", `The ${step} driver reports itself as ${driver.step}.`);
    return driver;
  }

  private context(record: FactoryInstallationRecord): FactoryInstallationContext {
    return Object.freeze({
      tenantId: record.tenantId, hostname: record.hostname, administratorEmail: record.administratorEmail, fleetId: record.fleetId,
      installationId: record.installationId, invitationId: record.invitationId, productDatabase: record.productDatabase, productRole: record.productRole,
      temporalNamespace: record.temporalNamespace, secretDirectory: record.secretDirectory, operatorDirectory: record.operatorDirectory,
    });
  }

  private async summary(tenantId: string): Promise<LocalInstallation> {
    const record = await this.ledger.installation(tenantId);
    if (!record) throw new FactoryProvisioningError("provisioning_unknown_tenant", `No installation is recorded for ${tenantId}.`);
    const steps = await this.ledger.steps(tenantId);
    return Object.freeze({
      tenantId: record.tenantId, installationId: record.installationId, hostname: record.hostname, phase: record.phase,
      productDatabase: record.productDatabase, productRole: record.productRole, temporalNamespace: record.temporalNamespace, secretBundlePath: record.secretDirectory,
      steps, state: PHASE_RANK[record.phase] >= PHASE_RANK.resources_prepared && PHASE_RANK[record.phase] <= PHASE_RANK.bootstrap_complete ? "ready" : "partial",
    });
  }

  async status(tenantId: string): Promise<LocalInstallation> { return this.summary(tenantId); }

  /**
   * Provision, or resume provisioning, one installation.
   *
   * `through` stops after the named step: the ledger then shows exactly the
   * phase the completed steps establish, which is how a partial tenant is
   * produced on purpose and proven to serve nothing.
   */
  async provision(request: FactoryInstallationRequest, options: { readonly through?: FactoryProvisioningStepName; readonly planLimits?: Readonly<Record<string, number>> } & FactoryOperationActor = {}): Promise<LocalInstallation> {
    assertFactoryInstallationRequest(request);
    await this.setup();
    const names = factoryInstallationNames(this.options.fleetId, request.tenantId, { secretsRoot: this.options.secretsRoot, operatorRoot: this.options.operatorRoot });
    // The durable intent, committed before any external effect so a crash in step 1 is recoverable.
    await this.ledger.record({
      tenantId: request.tenantId, fleetId: this.options.fleetId, installationId: randomUUID(), hostname: request.hostname, administratorEmail: request.administratorEmail.toLowerCase(),
      invitationId: randomUUID(), ...names, rolePlan: randomUUID(), databasePlan: randomUUID(), ...(options.planLimits ? { planLimits: options.planLimits } : {}),
    });
    return this.ledger.locked(request.tenantId, async () => {
      const record = await this.ledger.installation(request.tenantId);
      if (!record || record.hostname !== request.hostname || record.administratorEmail !== request.administratorEmail.toLowerCase() || record.fleetId !== this.options.fleetId
        || record.productDatabase !== names.productDatabase || record.productRole !== names.productRole || record.temporalNamespace !== names.temporalNamespace
        || record.secretDirectory !== names.secretDirectory || record.operatorDirectory !== names.operatorDirectory) {
        throw new FactoryProvisioningError("provisioning_request_conflict", "Provisioning request conflicts with its persisted tenant identity.");
      }
      if (PHASE_RANK[record.phase] >= PHASE_RANK.tearing_down) throw new FactoryProvisioningError("provisioning_torn_down", `Installation ${request.tenantId} is ${record.phase} and cannot be provisioned.`);
      const installation = this.context(record);
      await this.attribute(request.tenantId, "provision", options, options.through ? { through: options.through } : {});
      const through = options.through === undefined ? undefined : FACTORY_PROVISIONING_STEPS.find((spec) => spec.step === options.through)!.ordinal;
      const steps = new Map((await this.ledger.steps(request.tenantId)).map((step) => [step.step, step]));
      for (const spec of FACTORY_PROVISIONING_STEPS) {
        if (through !== undefined && spec.ordinal > through) break;
        const recorded = steps.get(spec.step)!;
        if (recorded.state === "complete") await this.verifyStep(installation, spec.step, recorded.resources);
        else {
          // The ledger's own order guard: a step that never ran while a later one is complete is refused, never
          // skipped past. A step that failed its re-verification resumes here; the later steps re-verify after it.
          if (recorded.state === "pending" && FACTORY_PROVISIONING_STEPS.some((later) => later.ordinal > spec.ordinal && steps.get(later.step)!.state === "complete")) {
            throw new FactoryProvisioningError("provisioning_ledger_out_of_order", `Step ${spec.step} of ${installation.tenantId} never ran, but a later step is complete.`, spec.step);
          }
          await this.runStep(installation, spec.step, recorded.resources);
          steps.set(spec.step, { ...recorded, state: "complete" });
        }
        if (spec.completes) await this.advance(installation.tenantId, spec.completes);
      }
      if ((through === undefined || through === FACTORY_PROVISIONING_STEPS.length)) {
        // The route opens only once every step, the invitation included, is complete.
        await this.options.drivers.ingress.serve(installation);
        await this.advance(installation.tenantId, "invitation_issued");
      }
      return this.summary(request.tenantId);
    });
  }

  /** Attribute an operation to whoever asked for it. */
  private async attribute(tenantId: string, operation: string, who: FactoryOperationActor | undefined, detail: Readonly<Record<string, string>> = {}): Promise<void> {
    await this.ledger.event({ tenantId, step: null, event: `operation.${operation}`, detail: { actor: (who?.actor ?? "unattributed").slice(0, 128), ...detail } });
  }

  private async advance(tenantId: string, phase: FactoryInstallationPhase): Promise<void> {
    const current = (await this.ledger.installation(tenantId))!.phase;
    if (PHASE_RANK[current] < PHASE_RANK[phase]) await this.ledger.setPhase(tenantId, phase);
  }

  private async runStep(installation: FactoryInstallationContext, step: FactoryProvisioningStepName, recorded: FactoryStepResources): Promise<void> {
    await this.ledger.stepStarted(installation.tenantId, step);
    try {
      await this.options.fault?.(step, "before");
      const resources = await this.driver(step).ensure(installation, Object.keys(recorded).length > 0 ? recorded : undefined);
      await this.options.fault?.(step, "after");
      await this.ledger.stepCompleted(installation.tenantId, step, resources);
    } catch (error) {
      await this.ledger.stepFailed(installation.tenantId, step, factoryStepFailure(error));
      throw error;
    }
  }

  private async verifyStep(installation: FactoryInstallationContext, step: FactoryProvisioningStepName, resources: FactoryStepResources): Promise<void> {
    try { await this.driver(step).verify(installation, resources); }
    catch (error) {
      await this.ledger.stepFailed(installation.tenantId, step, factoryStepFailure(error));
      throw error;
    }
  }

  /**
   * Record a human bootstrap observed from outside the installation.
   *
   * The observer reports routing and membership facts only: whether the
   * installation's first administrator completed bootstrap, and under which
   * invitation. The invited email becomes a membership REFERENCE in the
   * directory.
   */
  async observeBootstrap(tenantId: string, observer: FactoryBootstrapObserver, who?: FactoryOperationActor): Promise<LocalInstallation> {
    return this.ledger.locked(tenantId, async () => {
      const record = await this.ledger.installation(tenantId);
      if (!record) throw new FactoryProvisioningError("provisioning_unknown_tenant", `No installation is recorded for ${tenantId}.`);
      if (record.phase === "bootstrap_complete") return this.summary(tenantId);
      if (record.phase !== "invitation_issued") throw new FactoryProvisioningError("provisioning_phase_forbidden", `Bootstrap cannot be observed while ${tenantId} is ${record.phase}.`);
      await this.attribute(tenantId, "observe", who);
      const observation = await observer.observe(this.context(record));
      if (!observation.complete) return this.summary(tenantId);
      // Setup admits only the invited email with this invitation's token, so
      // the invitation identity is what ties the consent to the invited human.
      if (observation.invitationId !== record.invitationId) throw new FactoryProvisioningError("bootstrap_admin_mismatch", "The bootstrap was completed under a different invitation.");
      await this.ledger.addMembershipReference(tenantId, `admin:${record.administratorEmail}`);
      await this.ledger.setPhase(tenantId, "bootstrap_complete", { administrator: record.administratorEmail });
      return this.summary(tenantId);
    });
  }

  /**
   * Replace one step's credential, re-deliver it, and restart onto it.
   *
   * The superseded credential must stop working before this returns; each
   * driver's `rotate` proves that for its own credential. Only a COMPLETE step
   * rotates, so an invitation is never issued ahead of its deployment and
   * route. `deployment` rotates the mesh certificates and service tokens and
   * re-delivers everything; any other step's new credential is re-delivered
   * through step 5 once step 5 exists. The invitation delivers its own file.
   * A failure is recorded on the ledger and leaves the step `complete` with
   * its previous resources: every driver's rotation either finishes or leaves
   * the old credential in force.
   */
  async rotate(tenantId: string, step: Exclude<FactoryProvisioningStepName, "ingress">, who?: FactoryOperationActor): Promise<LocalInstallation> {
    return this.ledger.locked(tenantId, async () => {
      const record = await this.ledger.installation(tenantId);
      if (!record || PHASE_RANK[record.phase] < PHASE_RANK.resources_prepared || PHASE_RANK[record.phase] >= PHASE_RANK.tearing_down) throw new FactoryProvisioningError("provisioning_phase_forbidden", `Credentials of ${tenantId} cannot be rotated in its current phase.`);
      const installation = this.context(record);
      const steps = new Map((await this.ledger.steps(tenantId)).map((entry) => [entry.step, entry]));
      const driver = this.driver(step);
      if (!driver.rotate) throw new FactoryProvisioningError("provisioning_rotation_unsupported", `Step ${step} has no credential to rotate.`);
      if (steps.get(step)!.state !== "complete") throw new FactoryProvisioningError("provisioning_phase_forbidden", `Step ${step} of ${tenantId} is not complete and cannot be rotated.`);
      await this.attribute(tenantId, "rotate", who, { step });
      const deployment = steps.get("deployment")!;
      try {
        const rotated = await driver.rotate(installation, steps.get(step)!.resources);
        await this.ledger.stepCompleted(tenantId, step, rotated);
        if (step !== "deployment" && step !== "invitation" && deployment.state === "complete") await this.options.drivers.deployment.redeliver(installation, deployment.resources);
      } catch (error) {
        await this.ledger.event({ tenantId, step, event: "step.rotation_failed", detail: { code: factoryStepFailure(error).code } });
        throw error;
      }
      await this.ledger.event({ tenantId, step, event: "step.rotated", detail: {} });
      return this.summary(tenantId);
    });
  }

  /**
   * Tombstone the tenant: stop its traffic, stop its processes, withdraw every
   * credential, keep its release archive.
   *
   * Runs in reverse step order, and only over steps that created something.
   * The route is HELD first, so nothing reaches the installation while it is
   * dismantled. A step whose teardown finished but left a residue it has no
   * authority to remove (a seeded store identity) is recorded by name and the
   * teardown continues; any other failure stops the teardown with the tenant
   * still `tearing_down`, and a rerun resumes it.
   */
  async teardown(tenantId: string, input: { readonly reason: string } & FactoryOperationActor): Promise<FactoryTeardownOutcome> {
    return this.ledger.locked(tenantId, async () => {
      const record = await this.ledger.installation(tenantId);
      if (!record) throw new FactoryProvisioningError("provisioning_unknown_tenant", `No installation is recorded for ${tenantId}.`);
      if (record.phase === "torn_down" || record.phase === "purged") return { installation: await this.summary(tenantId), residues: [] };
      await this.attribute(tenantId, "teardown", input);
      await this.ledger.setPhase(tenantId, "tearing_down", { reason: input.reason.slice(0, 256) });
      const installation = this.context(record);
      const steps = new Map((await this.ledger.steps(tenantId)).map((entry) => [entry.step, entry]));
      if (steps.get("ingress")!.state !== "pending") await this.options.drivers.ingress.hold(installation);
      const residues: { step: FactoryProvisioningStepName; failure: FactoryStepFailure }[] = [];
      for (const spec of [...FACTORY_PROVISIONING_STEPS].reverse()) {
        const recorded = steps.get(spec.step)!;
        if (recorded.state === "pending" || recorded.state === "torn_down") continue;
        try { await this.driver(spec.step).teardown(installation, recorded.resources); }
        catch (error) {
          if (error instanceof FactoryProvisioningError && error.code.endsWith("_unsupported")) residues.push({ step: spec.step, failure: factoryStepFailure(error) });
          else { await this.ledger.event({ tenantId, step: spec.step, event: "teardown.failed", detail: { code: factoryStepFailure(error).code } }); throw error; }
        }
        await this.ledger.stepTornDown(tenantId, spec.step, residues.find((residue) => residue.step === spec.step) ? { residue: residues.find((residue) => residue.step === spec.step)!.failure.code } : {});
      }
      await this.ledger.setPhase(tenantId, "torn_down");
      return { installation: await this.summary(tenantId), residues };
    });
  }

  /**
   * Delete what teardown kept, once an administrator approved it and no work
   * is open.
   *
   * The approval is one the installation issued to an administrator's session
   * before teardown; the operator only names it. Purge drops the databases,
   * the runtime volumes, and the installation's delivered secrets. It NEVER
   * touches the release archive, and because an archived record may be
   * encrypted under the installation's data key, the master key and the
   * escrowed wrap stay in the operator's directory. It refuses while any work
   * is active or uncertain, because deleting the only record of an uncertain
   * effect would turn "we do not know" into "it never happened". The census
   * counts and everything purge cannot remove are the C06 audit-loss record.
   */
  async purge(tenantId: string, request: FactoryPurgeRequest & FactoryOperationActor, checks: FactoryPurgeChecks): Promise<LocalInstallation> {
    return this.ledger.locked(tenantId, async () => {
      const record = await this.ledger.installation(tenantId);
      if (record?.phase !== "torn_down") throw new FactoryProvisioningError("provisioning_phase_forbidden", `Only a torn-down installation can be purged; ${tenantId} is ${record?.phase ?? "unknown"}.`);
      const installation = this.context(record);
      await this.attribute(tenantId, "purge", request, { approvalId: request.approvalId.slice(0, 64) });
      const approval = await checks.approvals.verify(installation, request.approvalId);
      const open = await checks.census.count(installation);
      if (open.active > 0 || open.uncertain > 0) throw new FactoryProvisioningError("purge_work_open", `Purge refused: ${open.active} active and ${open.uncertain} uncertain records are still open.`);
      const steps = new Map((await this.ledger.steps(tenantId)).map((entry) => [entry.step, entry]));
      await this.options.drivers.deployment.purge(installation, steps.get("deployment")!.resources);
      await this.options.drivers.database.purge(installation, steps.get("database")!.resources);
      await escrowFactoryArchiveKey(installation);
      await this.ledger.event({ tenantId, step: null, event: "purge.audit_loss", detail: { approvedBy: approval.approvedBy, approvalId: request.approvalId, reason: request.reason.slice(0, 256), activeAtPurge: String(open.active), uncertainAtPurge: String(open.uncertain), ...FACTORY_PURGE_RETAINED } });
      await this.ledger.setPhase(tenantId, "purged", { approvedBy: approval.approvedBy });
      return this.summary(tenantId);
    });
  }

  /** Whether the ledger lets this installation receive traffic. The ingress route is the enforcement; this is the statement. */
  async servesTraffic(tenantId: string): Promise<boolean> {
    const record = await this.ledger.installation(tenantId);
    return record !== undefined && factoryPhaseServesTraffic(record.phase);
  }
}
