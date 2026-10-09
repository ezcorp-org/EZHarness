import { ProviderConnectionStore } from "./provider-connections/store";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { createHash, X509Certificate } from "node:crypto";
import type { LiveSandboxPresetQualification } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { digest } from "../../scripts/incus/model";
import type { Database } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import type { SandboxBinding, SandboxOperation } from "../db/schema";
import { validateIncusAdmissionObservation, admissionAuthority, IncusAdmissionReadinessError, type IncusAdmissionAuthority, type IncusAdmissionObservation } from "./incus-admission-contract";
import type { IncusQualificationScope, IncusQualificationStore } from "./incus-qualification";
import { requestIncusAdmissionReadiness, type IncusSupervisorSelectedPin } from "./incus-qualification-supervisor-client";

type Qualifications = Pick<IncusQualificationStore, "authorizeFixture" | "loadBaselineProof">;
type Selection = Awaited<ReturnType<Qualifications["authorizeFixture"]>>;
interface Pins { pin: IncusSupervisorSelectedPin; releaseDigest: string; generation: number; certificate: string; project: string; backendProfile: string }
interface Baseline { runId: string; proofDigest: string; pins: Pins; authority: IncusAdmissionAuthority; verifiedAt: Date | string }
export interface IncusAdmissionReady {
  qualification: LiveSandboxPresetQualification;
  baselineDigest: string;
  baselineRunId: string;
  validUntil: number;
  verifiedAt: number;
  pins: Pins;
}
export interface PreparedIncusAdmissionBaseline {
  scope: IncusQualificationScope;
  runId: string;
  qualification: LiveSandboxPresetQualification;
  selected: Pins;
  authority: IncusAdmissionAuthority;
  validUntil: number;
}
interface ReadyResult { ready: IncusAdmissionReady; observation: IncusAdmissionObservation }
export interface IncusAdmissionReadinessDependencies {
  now?: () => number;
  assertCurrentScope?: ProviderConnectionStore["assertCurrentScope"];
  timeoutMs?: number;
  read?: (pin: IncusSupervisorSelectedPin) => Promise<IncusAdmissionObservation>;
}
const READY_LIFETIME_MS = 15_000;
const inFlight = new WeakMap<Database, Map<string, Promise<ReadyResult>>>();

function pins(scope: IncusQualificationScope, selected: Selection): Pins {
  if (!Number.isSafeInteger(selected.snapshot.installation.generation) || selected.snapshot.installation.generation < 1) throw new IncusAdmissionReadinessError("readiness_unavailable");
  return { pin: { scope, connectionRevision: selected.connection.revision,
    presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
    imageFingerprint: selected.preset.imageDigest, helperSha256: selected.helperDigest },
    releaseDigest: selected.snapshot.release.releaseDigest, generation: selected.snapshot.installation.generation,
    certificate: createHash("sha256").update(new X509Certificate(selected.connection.serverCertificatePem).raw).digest("hex"),
    project: selected.connection.project, backendProfile: selected.connection.configuration.profile };
}

function requireSame(actual: unknown, expected: unknown, code: "qualification_expired" | "readiness_unavailable" = "qualification_expired"): void {
  if (digest(actual) !== digest(expected)) throw new IncusAdmissionReadinessError(code);
}

/** Evidence is durable; only a fresh protected read can authorize admission. */
export class IncusAdmissionReadinessService {
  private readonly now: () => number;
  private readonly assertCurrentScope: ProviderConnectionStore["assertCurrentScope"];
  private readonly read: NonNullable<IncusAdmissionReadinessDependencies["read"]>;
  constructor(private readonly db: Database, private readonly qualifications: Qualifications,
    deps: IncusAdmissionReadinessDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.assertCurrentScope = deps.assertCurrentScope ?? ((scope, transaction) => new ProviderConnectionStore(this.db).assertCurrentScope(scope, transaction));
    const read = deps.read ?? (pin => requestIncusAdmissionReadiness(process.env.EZCORP_INCUS_SUPERVISOR_SOCKET ?? "", pin));
    const timeoutMs = deps.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new RangeError("Incus readiness timeout is invalid");
    this.read = async pin => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        const observation = await Promise.race([read(pin), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new IncusAdmissionReadinessError("readiness_unavailable", "deadline_exceeded")), timeoutMs);
        })]);
        return validateIncusAdmissionObservation(observation, pin);
      } catch (error) {
        throw error instanceof IncusAdmissionReadinessError ? error : new IncusAdmissionReadinessError("readiness_unavailable");
      } finally { clearTimeout(timer!); }
    };
  }

  async capture(scope: IncusQualificationScope, runId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runId)) throw new IncusAdmissionReadinessError("readiness_unavailable");
    const selected = pins(scope, await this.qualifications.authorizeFixture(scope));
    const observation = await this.read(selected.pin);
    requireSame(selected, pins(scope, await this.qualifications.authorizeFixture(scope)), "readiness_unavailable");
    const authority = admissionAuthority(observation);
    await this.db.execute(sql`INSERT INTO incus_qualification_authority_captures(run_id, scope, pins, authority)
      VALUES (${runId}, ${JSON.stringify(scope)}::text::jsonb, ${JSON.stringify(selected)}::text::jsonb, ${JSON.stringify(authority)}::text::jsonb)
      ON CONFLICT (run_id) DO NOTHING`);
    const [captured] = releaseRows<{ scope: unknown; pins: unknown; authority: unknown }>(await this.db.execute(sql`
      SELECT scope, pins, authority FROM incus_qualification_authority_captures WHERE run_id = ${runId}`));
    requireSame(captured, { scope, pins: selected, authority }, "readiness_unavailable");
  }

  async prepareBaseline(scope: IncusQualificationScope, runId: string, qualification: LiveSandboxPresetQualification): Promise<PreparedIncusAdmissionBaseline> {
    const start = this.now();
    const [captured] = releaseRows<{ scope: IncusQualificationScope; pins: Pins; authority: IncusAdmissionAuthority }>(await this.db.execute(sql`
      SELECT scope, pins, authority FROM incus_qualification_authority_captures WHERE run_id = ${runId}`));
    if (!captured) throw new IncusAdmissionReadinessError("qualification_expired");
    const selected = pins(scope, await this.qualifications.authorizeFixture(scope));
    const observation = await this.read(selected.pin);
    requireSame(captured, { scope, pins: selected, authority: admissionAuthority(observation) });
    requireSame(observation.observation.backend.backendVersion, qualification.backendVersion);
    return { scope, runId, qualification, selected, authority: captured.authority, validUntil: start + READY_LIFETIME_MS };
  }

  async recordBaseline(prepared: PreparedIncusAdmissionBaseline, database: Database = this.db): Promise<void> {
    const { scope, runId, qualification, selected, authority } = prepared;
    this.assertDeadline(prepared);
    requireSame(selected, pins(scope, await this.qualifications.authorizeFixture(scope,
      database === this.db ? undefined : database)), "readiness_unavailable");
    await database.execute(sql`INSERT INTO incus_admission_baselines
      (installation_id, connection_id, preset_id, run_id, proof_digest, pins, authority, verified_at)
      VALUES (${scope.installationId}, ${scope.connectionId}, ${scope.presetId}, ${runId}, ${digest(qualification)},
      ${JSON.stringify(selected)}::text::jsonb, ${JSON.stringify(authority)}::text::jsonb, ${new Date(qualification.verifiedAt)})
      ON CONFLICT (installation_id, connection_id, preset_id) DO UPDATE SET
      run_id = EXCLUDED.run_id, proof_digest = EXCLUDED.proof_digest, pins = EXCLUDED.pins,
      authority = EXCLUDED.authority, verified_at = EXCLUDED.verified_at`);
  }

  private async baseline(scope: IncusQualificationScope): Promise<Baseline> {
    const [baseline] = releaseRows<Baseline>(await this.db.execute(sql`SELECT run_id AS "runId", proof_digest AS "proofDigest",
      pins, authority, verified_at AS "verifiedAt" FROM incus_admission_baselines
      WHERE installation_id = ${scope.installationId} AND connection_id = ${scope.connectionId} AND preset_id = ${scope.presetId}`));
    if (!baseline) throw new IncusAdmissionReadinessError("qualification_expired");
    return { ...baseline, verifiedAt: new Date(baseline.verifiedAt).toISOString() };
  }

  async check(scope: IncusQualificationScope, requireCapacity = true): Promise<IncusAdmissionReady> {
    const baseline = await this.baseline(scope);
    const key = digest({ scope, baseline, requireCapacity });
    let pending = inFlight.get(this.db);
    if (!pending) { pending = new Map(); inFlight.set(this.db, pending); }
    let result = pending.get(key);
    if (!result) {
      result = this.observe(scope, baseline, key, requireCapacity).finally(() => pending!.delete(key));
      pending.set(key, result);
    }
    const { ready } = await result;
    this.assertDeadline(ready);
    requireSame(baseline.pins, pins(scope, await this.qualifications.authorizeFixture(scope)), "readiness_unavailable");
    return ready;
  }

  assertDeadline(ready: { validUntil: number }): void {
    if (this.now() >= ready.validUntil) throw new IncusAdmissionReadinessError("readiness_unavailable");
  }

  private async observe(scope: IncusQualificationScope, baseline: Baseline, scopeDigest: string, requireCapacity: boolean): Promise<ReadyResult> {
    const start = this.now();
    const baselineDigest = digest(baseline);
    try {
      const selected = await this.qualifications.authorizeFixture(scope);
      requireSame(baseline.pins, pins(scope, selected));
      const qualification = await this.qualifications.loadBaselineProof(scope, baseline.proofDigest);
      if (!qualification) throw new IncusAdmissionReadinessError("qualification_expired");
      const observation = await this.read(baseline.pins.pin);
      requireSame(baseline.authority, admissionAuthority(observation));
      requireSame(observation.observation.backend.backendVersion, qualification.backendVersion);
      requireSame(baseline.pins, pins(scope, await this.qualifications.authorizeFixture(scope)), "readiness_unavailable");
      const ready = { qualification, baselineDigest, baselineRunId: baseline.runId, validUntil: start + READY_LIFETIME_MS,
        verifiedAt: new Date(baseline.verifiedAt).getTime(), pins: baseline.pins };
      this.assertDeadline(ready);
      this.assertObservationTime(observation);
      if (requireCapacity) this.assertCapacity(selected, observation);
      await this.persistReadiness(scopeDigest, baselineDigest, start, ready.validUntil, observation, null);
      return { ready, observation };
    } catch (error) {
      const failure = error instanceof IncusAdmissionReadinessError ? error : new IncusAdmissionReadinessError("readiness_unavailable");
      await this.persistReadiness(scopeDigest, baselineDigest, start, start, null, failure.code);
      throw failure;
    }
  }

  private assertObservationTime(observation: IncusAdmissionObservation): void {
    const capturedAt = Date.parse(observation.observation.capacity.capturedAt);
    if (capturedAt < this.now() - READY_LIFETIME_MS || capturedAt > this.now()) {
      throw new IncusAdmissionReadinessError("readiness_unavailable");
    }
  }

  private assertCapacity(selected: Selection, observation: IncusAdmissionObservation): void {
    const { capacity } = observation.observation;
    const limits = selected.preset.limits;
    if (capacity.availableMemoryBytes < limits.memoryBytes || capacity.poolFreeBytes < limits.diskBytes
      || capacity.availablePids < limits.pids || capacity.cpuThreads * 1000 < limits.cpuMillis) {
      throw new IncusAdmissionReadinessError("capacity_full");
    }
  }

  private async persistReadiness(scopeDigest: string, baselineDigest: string, observedAt: number,
    validUntil: number, result: IncusAdmissionObservation | null, failure: string | null): Promise<void> {
    await this.db.execute(sql`INSERT INTO incus_admission_readiness(scope_digest, baseline_digest, observed_at, valid_until, result, failure)
      VALUES (${scopeDigest}, ${baselineDigest}, ${new Date(observedAt)}, ${new Date(validUntil)},
      ${result ? JSON.stringify(result) : null}::jsonb, ${failure}) ON CONFLICT (scope_digest) DO UPDATE SET
      baseline_digest = EXCLUDED.baseline_digest, observed_at = EXCLUDED.observed_at,
      valid_until = EXCLUDED.valid_until, result = EXCLUDED.result, failure = EXCLUDED.failure`);
  }

  async claim(bindingId: string, request: { idempotencyScope: string; idempotencyKey: string },
    ready: IncusAdmissionReady, database: Database = this.db): Promise<void> {
    this.assertDeadline(ready);
    const selected = ready.pins;
    await this.assertCurrentScope({ connectionId: selected.pin.scope.connectionId,
      providerInstallationId: selected.pin.scope.installationId, providerReleaseId: selected.pin.scope.releaseId,
      releaseDigest: selected.releaseDigest, generation: selected.generation,
      revision: selected.pin.connectionRevision }, database);
    this.assertDeadline(ready);
    const [claimed] = releaseRows<{ baselineDigest: string }>(await database.execute(sql`INSERT INTO incus_admission_claims(binding_id, idempotency_scope, idempotency_key, baseline_digest, valid_until)
      VALUES (${bindingId}, ${request.idempotencyScope}, ${request.idempotencyKey}, ${ready.baselineDigest}, ${new Date(ready.validUntil)})
      ON CONFLICT (binding_id, idempotency_scope, idempotency_key) DO UPDATE SET valid_until = EXCLUDED.valid_until
      WHERE incus_admission_claims.baseline_digest = EXCLUDED.baseline_digest
      RETURNING baseline_digest AS "baselineDigest"`));
    if (claimed?.baselineDigest !== ready.baselineDigest) throw new IncusAdmissionReadinessError("readiness_unavailable");
  }

  async assertDispatch(binding: SandboxBinding, operation: SandboxOperation): Promise<IncusAdmissionReady> {
    const [claim] = releaseRows<{ baselineDigest: string; validUntil: Date | string }>(await this.db.execute(sql`
      SELECT baseline_digest AS "baselineDigest", valid_until AS "validUntil" FROM incus_admission_claims
      WHERE binding_id = ${binding.id} AND idempotency_scope = ${operation.idempotencyScope} AND idempotency_key = ${operation.idempotencyKey}`));
    if (!claim) throw new IncusAdmissionReadinessError("readiness_unavailable");
    const current = await this.check({ installationId: binding.providerInstallationId, releaseId: binding.providerReleaseId,
      connectionId: binding.connectionId, presetId: binding.presetId! }, false);
    requireSame(claim.baselineDigest, current.baselineDigest, "readiness_unavailable");
    await new SandboxAdmissionStore(this.db).authorizeReservedAdmission({ bindingId: binding.id,
      generation: operation.generation, kind: operation.kind as "CREATE" | "START",
      idempotencyScope: operation.idempotencyScope, idempotencyKey: operation.idempotencyKey },
      transaction => this.claim(binding.id, operation, current, transaction));
    return current;
  }
}
