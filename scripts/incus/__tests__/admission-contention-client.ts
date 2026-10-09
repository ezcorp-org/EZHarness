/** Owned managed child: real PGlite, service, reservation locks, broker and socket.
 * Selection/connection authority and provider transport are controlled fixtures;
 * no readiness result, authorization decision or broker failure is fabricated.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { LiveSandboxPresetQualification } from "@ezcorp/extension-contract";
import * as schema from "../../../src/db/schema";
import { up as addController } from "../../../src/db/migrations/add-sandbox-controller";
import { up as addReadiness } from "../../../src/db/migrations/add-incus-admission-readiness";
import { SandboxController } from "../../../src/sandboxes/controller";
import { SandboxAdmissionStore } from "../../../src/sandboxes/admission";
import { IncusAdmissionReadinessService } from "../../../src/infrastructure/incus-admission-readiness";
import { IncusQualificationStore } from "../../../src/infrastructure/incus-qualification";
import { ProviderConnectionStore } from "../../../src/infrastructure/provider-connections/store";
import { ProviderRpcBroker, type PreparedIncusAction, type ProviderConnectionResolver } from "../../../src/infrastructure/provider-rpc-broker";
import { requestIncusAdmissionReadiness } from "../../../src/infrastructure/incus-qualification-supervisor-client";
import { admissionPin, admissionSelection } from "../../../src/infrastructure/__tests__/incus-admission-observation";
import { createIncusTransportCommand } from "../../../extensions/incus-sandbox/adapter";
import { digest } from "../model";

async function run() {
  const client = new PGlite();
  try {
    await client.waitReady;
    await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, purpose TEXT NOT NULL DEFAULT 'user')");
    const db = drizzle(client, { schema });
    await addController(db); await addReadiness(db);
    await db.execute(sql`INSERT INTO projects(id) VALUES ('project')`);
    const selected = admissionSelection();
    const qualification = { verifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
      validUntil: new Date(Date.now() - 1).toISOString(), backendVersion: "6.0.6" } as LiveSandboxPresetQualification;
    IncusQualificationStore.prototype.authorizeFixture = async () => selected;
    IncusQualificationStore.prototype.loadBaselineProof = async (_scope, proof) => proof === digest(qualification) ? qualification : null;
    ProviderConnectionStore.prototype.assertCurrentScope = async scope => {
      if (scope.generation !== 1 || scope.revision !== 1 || scope.connectionId !== "connection") throw new Error("fixture authority changed");
    };
    const qualifications = new IncusQualificationStore({ db });
    const originalAssertDispatch = IncusAdmissionReadinessService.prototype.assertDispatch;
    let dispatchFailure: { code?: string; reason?: string } | undefined;
    IncusAdmissionReadinessService.prototype.assertDispatch = async function (...args) {
      try { return await originalAssertDispatch.apply(this, args); }
      catch (error) {
        const failure = error as { code?: string; reason?: string };
        dispatchFailure = { code: failure.code, reason: failure.reason };
        throw error;
      }
    };
    let socketCalls = 0;
    const read = async (pin: typeof admissionPin) => {
      socketCalls++;
      return requestIncusAdmissionReadiness(process.env.CONTROL!, pin);
    };
    const service = new IncusAdmissionReadinessService(db, qualifications, { read });
    process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = process.env.CONTROL;
    await service.capture(admissionPin.scope, "baseline");
    await service.recordBaseline(await service.prepareBaseline(admissionPin.scope, "baseline", qualification));
    const controller = new SandboxController(db, {
      dispatch: async () => { throw new Error("unexpected controller dispatch"); },
      inspectOperation: async () => { throw new Error("unexpected provider inspection"); },
    });
    const binding = await controller.createBinding({ id: "binding", projectId: "project", providerInstallationId: "installation",
      providerReleaseId: "release", connectionId: "connection", connectionRevision: 1, resourceKey: "binding",
      profile: "profile", presetId: "preset", presetDigest: admissionPin.presetDigest,
      effectiveSettingsDigest: admissionPin.effectiveSettingsDigest });
    const resources = { memoryBytes: 1024, cpuMillicores: 1000, pids: 10, diskBytes: 4096, executionSlots: 1 };
    const admission = new SandboxAdmissionStore(db);
    await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
      allocatable: { memoryBytes: 10240, cpuMillicores: 10000, pids: 100, diskBytes: 40960, executionSlots: 10 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
    await admission.configureProjectQuota({ projectId: "project", providerInstallationId: "installation", connectionId: "connection", limit: resources });
    const request = { bindingId: binding.id, generation: 1, kind: "CREATE" as const, idempotencyScope: "feature", idempotencyKey: "create", resources };
    const ready = await service.check(admissionPin.scope);
    await admission.requestAdmission(request, tx => service.claim(binding.id, request, ready, tx));
    const operation = await controller.journalOperation({ ...request, payload: {} });
    let transportCalls = 0;
    const broker = new ProviderRpcBroker({} as ProviderConnectionResolver, undefined, db,
      () => ({ request: async () => { transportCalls++; return { ok: true }; } }));
    const input = { providerId: "incus", connectionId: "connection", sandboxId: binding.id,
      requestId: operation.id, idempotencyKey: operation.idempotencyKey, rpcDeadlineMs: Date.now() + 30_000 };
    const config = { connectionId: "connection", project: "project", profile: "profile", serverCertificateSha256: "c".repeat(64), helperVersion: "0.1.0", guestUser: "sandbox" };
    const action: PreparedIncusAction = { installationId: "installation", releaseId: "release", releaseDigest: "release-digest", generation: 1,
      connectionId: "connection", revision: 1, config, operation: "lifecycle.create", method: "incus/lifecycle/create",
      bindingId: binding.id, projectId: binding.projectId!, bindingGeneration: 1, resourceKey: binding.resourceKey!,
      approvedPreset: { profile: "profile", incusProfile: "profile", presetId: "preset", presetDigest: admissionPin.presetDigest,
        effectiveSettingsDigest: admissionPin.effectiveSettingsDigest, imageFingerprint: admissionPin.imageFingerprint, limits: selected.preset.limits },
      approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: admissionPin.helperSha256 },
      expectedCommand: createIncusTransportCommand("lifecycle.create", input, config) };
    const receiptStarted = join(dirname(process.env.RESULT!), "receipt-started");
    unlinkSync(receiptStarted);
    writeFileSync(process.env.RECEIPT_DELAY_FILE!, "6.5");
    const started = performance.now();
    const management = service.check(admissionPin.scope);
    while (!existsSync(receiptStarted)) await Bun.sleep(5);
    const dispatched = broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs);
    const [managementResult, dispatch] = await Promise.all([management, dispatched]);
    await broker.stopObservations();
    return { managementReady: managementResult.baselineRunId === "baseline", dispatch, dispatchFailure, transportCalls,
      socketCalls, elapsedMs: performance.now() - started };
  } finally { await client.close(); }
}
let result: Awaited<ReturnType<typeof run>> | { failed: true; error: string };
try { result = await run(); }
catch (error) { result = { failed: true, error: String(error) }; }
writeFileSync(process.env.RESULT!, JSON.stringify(result));
while (true) await Bun.sleep(100);
