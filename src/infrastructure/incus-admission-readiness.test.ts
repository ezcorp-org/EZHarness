import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { LiveSandboxPresetQualification } from "@ezcorp/extension-contract";
import { up } from "../db/migrations/add-incus-admission-readiness";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import { SandboxController } from "../sandboxes/controller";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { releaseRows } from "../db/queries/extension-releases";
import { digest } from "../../scripts/incus/model";
import { IncusAdmissionReadinessService } from "./incus-admission-readiness";
import { admissionPin, admissionObservation, admissionSelection } from "./__tests__/incus-admission-observation";

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });
async function fixture() {
  const client = new PGlite(); databases.push(client); await client.waitReady;
  await client.exec("CREATE TABLE projects(id TEXT PRIMARY KEY)");
  const db = drizzle(client, { schema }); await addController(db); await up(db); await up(db);
  let now = Date.parse("2026-10-08T12:00:00Z");
  let calls = 0;
  let missing = false;
  let fail = false;
  let partial = false;
  let gate: Promise<void> | undefined;
  const source = admissionObservation(admissionPin, now);
  const selected = admissionSelection();
  const qualification = { verifiedAt: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(), backendVersion: "6.0.6" } as LiveSandboxPresetQualification;
  const qualifications = { authorizeFixture: async () => selected,
    loadBaselineProof: async (_scope: unknown, proofDigest: string) => missing || proofDigest !== digest(qualification) ? null : qualification };
  const deps = { now: () => now, assertCurrentScope: async () => {}, read: async (pin: typeof admissionPin) => {
    calls++; await gate;
    if (fail) throw new Error("protected verifier is unavailable");
    return partial ? {} as typeof source : { ...source, selectedPin: pin, observation: { ...source.observation,
      capacity: { ...source.observation.capacity, capturedAt: new Date(now).toISOString() } } };
  } };
  const service = new IncusAdmissionReadinessService(db, qualifications, deps);
  const baseline = async () => { await service.capture(admissionPin.scope, "run");
    await service.recordBaseline(await service.prepareBaseline(admissionPin.scope, "run", qualification)); };
  return { db, service, source, selected, qualification, qualifications, deps, baseline,
    setNow: (value: number) => { now = value; }, getNow: () => now, calls: () => calls,
    setMissing: (value: boolean) => { missing = value; }, setFail: (value: boolean) => { fail = value; },
    setPartial: (value: boolean) => { partial = value; }, setGate: (value: Promise<void> | undefined) => { gate = value; } };
}

test("baseline captures the original proof and admits after one hour and a service reconstruction", async () => {
  const f = await fixture();
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
  await f.baseline();
  const original = structuredClone(f.qualification);
  const before = f.calls();
  f.setNow(f.getNow() + 3_600_000);
  const ready = await f.service.check(admissionPin.scope);
  expect(ready.qualification).toEqual(original);
  expect(ready.validUntil).toBe(f.getNow() + 15_000);
  const reopened = new IncusAdmissionReadinessService(f.db, f.qualifications, f.deps);
  expect((await reopened.check(admissionPin.scope)).baselineDigest).toBe(ready.baselineDigest);
  expect(f.calls() - before).toBe(2);
  expect((await f.db.execute(sql`SELECT * FROM incus_admission_readiness`)).rows).toHaveLength(1);
  f.service.assertDeadline(ready);
  f.setNow(ready.validUntil);
  expect(() => f.service.assertDeadline(ready)).toThrow("readiness_unavailable");
});

test("capture is idempotent and drift cannot replace original run authority", async () => {
  const f = await fixture(); await f.baseline();
  await f.service.capture(admissionPin.scope, "run");
  await expect(f.service.capture(admissionPin.scope, "bad run")).rejects.toThrow("readiness_unavailable");
  f.source.authority.hostPolicyDigest = "9".repeat(64);
  await expect(f.service.capture(admissionPin.scope, "run")).rejects.toThrow("readiness_unavailable");
  await expect(f.service.prepareBaseline(admissionPin.scope, "run", { ...f.qualification, backendVersion: "changed" })).rejects.toThrow("qualification_expired");
  await expect(f.service.prepareBaseline(admissionPin.scope, "missing", f.qualification)).rejects.toThrow("qualification_expired");
  await expect(f.service.prepareBaseline(admissionPin.scope, "run", f.qualification)).rejects.toThrow("qualification_expired");
});

test("initial capture sanitizes transport failure before saving authority", async () => {
  const f = await fixture();
  f.setFail(true);
  await expect(f.service.capture(admissionPin.scope, "failed-capture")).rejects.toMatchObject({
    name: "IncusAdmissionReadinessError", code: "readiness_unavailable", message: "readiness_unavailable", reason: "unavailable",
  });
  const deadline = new IncusAdmissionReadinessService(f.db, f.qualifications, { ...f.deps, timeoutMs: 1, read: () => new Promise(() => {}) });
  await expect(deadline.capture(admissionPin.scope, "expired-capture")).rejects.toMatchObject({
    code: "readiness_unavailable", reason: "deadline_exceeded",
  });
  expect((await f.db.execute(sql`SELECT * FROM incus_qualification_authority_captures`)).rows).toHaveLength(0);
});

test("every immutable authority identity drifts closed without another full run", async () => {
  const f = await fixture(); await f.baseline();
  for (const key of Object.keys(f.source.authority) as (keyof typeof f.source.authority)[]) {
    const old = f.source.authority[key]; f.source.authority[key] = "9".repeat(64);
    await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
    f.source.authority[key] = old;
  }
  f.source.observation.hostPolicyDigest = "9".repeat(64);
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
  f.source.observation.hostPolicyDigest = "4".repeat(64);
  for (const key of ["backendVersion", "architecture", "backendApi", "storageDriver", "isolation"] as const) {
    const old = f.source.observation.backend;
    f.source.observation.backend = { ...old, [key]: "changed" } as typeof old;
    await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
    f.source.observation.backend = old;
  }
  f.selected.connection.revision++;
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
  f.selected.connection.revision--;
  f.setMissing(true);
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
  f.setMissing(false);
  f.qualification.backendVersion = "changed";
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("qualification_expired");
});

test("readonly failure removes success evidence and a later request probes again", async () => {
  const f = await fixture(); await f.baseline(); await f.service.check(admissionPin.scope);
  f.setFail(true);
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("readiness_unavailable");
  const rows = releaseRows<{ result: unknown; failure: string }>(await f.db.execute(sql`SELECT result,failure FROM incus_admission_readiness`));
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ result: null, failure: "readiness_unavailable" });
  f.setFail(false); f.setPartial(true);
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("readiness_unavailable");
  f.setPartial(false); expect((await f.service.check(admissionPin.scope)).qualification).toBe(f.qualification);
});

test("concurrent exact scopes coalesce only in flight and recheck after the probe", async () => {
  const f = await fixture(); await f.baseline();
  let release!: () => void; f.setGate(new Promise<void>(resolve => { release = resolve; }));
  const before = f.calls();
  const checks = [f.service.check(admissionPin.scope), f.service.check(admissionPin.scope)];
  await new Promise(resolve => setTimeout(resolve, 0)); release();
  expect((await Promise.all(checks))[0]!.baselineDigest).toBe((await checks[1]!).baselineDigest);
  expect(f.calls() - before).toBe(1);
  f.setGate(undefined);
  const drift = new IncusAdmissionReadinessService(f.db, f.qualifications, { ...f.deps, read: async pin => {
    const result = await f.deps.read(pin); f.selected.connection.project = "changed"; return result;
  } });
  await expect(drift.check(admissionPin.scope)).rejects.toThrow("readiness_unavailable");
});

test("capacity denial is distinct, partial data and bounded timeout are unavailable", async () => {
  const f = await fixture(); await f.baseline();
  f.source.observation.capacity.availableMemoryBytes = 0;
  await expect(f.service.check(admissionPin.scope)).rejects.toThrow("capacity_full");
  expect((await f.service.check(admissionPin.scope, false)).qualification).toBe(f.qualification);
  f.source.observation.capacity.availableMemoryBytes = 2 ** 40;
  for (const timeoutMs of [0, 12_001, 1.5]) expect(() => new IncusAdmissionReadinessService(f.db, f.qualifications, { timeoutMs })).toThrow("timeout is invalid");
  const timeout = new IncusAdmissionReadinessService(f.db, f.qualifications, { ...f.deps, timeoutMs: 1, read: () => new Promise(() => {}) });
  await expect(timeout.check(admissionPin.scope)).rejects.toThrow("readiness_unavailable");
  const defaults = new IncusAdmissionReadinessService(f.db, f.qualifications, { now: f.deps.now });
  await expect(defaults.check(admissionPin.scope)).rejects.toThrow("readiness_unavailable");
  await expect(defaults.claim("binding", { idempotencyScope: "feature", idempotencyKey: "default" }, await f.service.check(admissionPin.scope))).rejects.toThrow();
});

test("baseline commit checks deadline and unchanged source without another network read", async () => {
  const f = await fixture(); await f.baseline();
  const prepared = await f.service.prepareBaseline(admissionPin.scope, "run", f.qualification);
  const calls = f.calls(); await f.service.recordBaseline(prepared); expect(f.calls()).toBe(calls);
  f.setNow(prepared.validUntil);
  await expect(f.service.recordBaseline(prepared)).rejects.toThrow("readiness_unavailable");
  f.setNow(prepared.validUntil - 1); f.selected.connection.revision++;
  await expect(f.service.recordBaseline(prepared)).rejects.toThrow("readiness_unavailable");
});

test("a delayed dispatch renews the same baseline under actual quota and reservation locks", async () => {
  const f = await fixture(); await f.baseline();
  await f.db.execute(sql`INSERT INTO projects(id) VALUES ('project')`);
  const controller = new SandboxController(f.db, { dispatch: async () => ({ outcome: "UNKNOWN" }), inspectOperation: async () => ({ outcome: "UNKNOWN" }) });
  const binding = await controller.createBinding({ id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: 1,
    resourceKey: "binding", profile: "profile", presetId: "preset", presetDigest: admissionPin.presetDigest,
    effectiveSettingsDigest: admissionPin.effectiveSettingsDigest });
  const admission = new SandboxAdmissionStore(f.db);
  const resources = { memoryBytes: 1024, cpuMillicores: 1000, pids: 10, diskBytes: 4096, executionSlots: 1 };
  await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: { memoryBytes: 10240, cpuMillicores: 10000, pids: 100, diskBytes: 40960, executionSlots: 10 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  await admission.configureProjectQuota({ projectId: "project", providerInstallationId: "installation", connectionId: "connection", limit: resources });
  const request = { bindingId: binding.id, generation: 1, kind: "CREATE" as const, idempotencyScope: "feature", idempotencyKey: "create", resources };
  const ready = await f.service.check(admissionPin.scope);
  expect((await admission.requestAdmission(request, transaction => f.service.claim(binding.id, request, ready, transaction))).state).toBe("ADMITTED");
  await expect(f.service.claim(binding.id, request, { ...ready, baselineDigest: "foreign-baseline" })).rejects.toThrow("readiness_unavailable");
  const operation = await controller.journalOperation({ ...request, payload: {} });
  await expect(f.service.assertDispatch(binding, { ...operation, idempotencyKey: "missing" })).rejects.toThrow("readiness_unavailable");
  f.setNow(f.getNow() + 3_600_000);
  f.source.observation.capacity.availableMemoryBytes = 0;
  f.source.observation.capacity.poolFreeBytes = 0;
  await f.service.assertDispatch(binding, operation);
  const [claim] = releaseRows<{ validUntil: Date }>(await f.db.execute(sql`SELECT valid_until AS "validUntil" FROM incus_admission_claims`));
  expect(new Date(claim!.validUntil).getTime()).toBe(f.getNow() + 15_000);
  f.source.authority.securitySourceDigest = "9".repeat(64);
  await expect(f.service.assertDispatch(binding, operation)).rejects.toThrow("qualification_expired");
  f.source.authority.securitySourceDigest = "1".repeat(64);
  await f.db.execute(sql`UPDATE sandbox_project_quotas SET memory_bytes = 1 WHERE project_id = 'project'`);
  await expect(f.service.assertDispatch(binding, operation)).rejects.toThrow("exceeds current quota or capacity");
  await f.db.execute(sql`UPDATE sandbox_reservations SET compute_state = 'RELEASED' WHERE binding_id = 'binding'`);
  await expect(f.service.assertDispatch(binding, operation)).rejects.toThrow("no longer owns current reserved capacity");
  f.setNow(ready.validUntil);
  await expect(f.service.claim(binding.id, request, ready)).rejects.toThrow("readiness_unavailable");
});
