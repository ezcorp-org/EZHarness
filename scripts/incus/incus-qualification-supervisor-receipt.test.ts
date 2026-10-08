import { afterAll, expect, spyOn, test } from "bun:test";
import { createServer } from "node:https";
import { createServer as createUnixServer, type AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { observationDigest } from "../../src/infrastructure/incus-qualification-checkpoint";
import type { RecoveryObservation } from "../../src/infrastructure/incus-live-recovery-probes";
import { resourceName } from "../../src/infrastructure/incus-transport/lifecycle";
import { makeTestCertificates } from "../../src/infrastructure/incus-transport/test-certificates";
import recipe from "./recipe.json";
import { createIncusQualificationWitness, resumePendingIncusQualification } from "../../src/infrastructure/incus-startup";
import { IncusHostLiveWitness, incusHostLiveWitnessReady } from "../../src/infrastructure/incus-host-live-witness";
import { requestIncusSupervisorReceipt } from "../../src/infrastructure/incus-qualification-supervisor-client";
import { IncusLiveProbeFixtureService } from "../../src/infrastructure/incus-live-probe-fixtures";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const source = join(import.meta.dir, "incus-qualification-supervisor-receipt.ts");
const preset = INCUS_PRESETS[0]!;
const scope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: preset.id };
const request = { version: 1, action: "restart", runId: "run", nonce: "nonce",
  deadlineMs: 0, scope, fixtureOperationId: "fixture", bindingId: "binding",
  generation: 3, connectionRevision: 2, lastOperationId: "operation", beforeDigest: "" };
const oldProcess = { pid: 111, startTicks: "222" };
const newProcess = { pid: 333, startTicks: "444" };
const operation = { id: "operation", kind: "STOP", state: "SUCCEEDED", generation: 3,
  providerOperationId: "provider-operation", errorCode: null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };
const durable = { fixture: { operationId: "fixture", installationId: "installation",
  releaseId: "release", connectionId: "connection", connectionRevision: 2,
  presetId: preset.id, projectId: "project", bindingId: "binding" },
binding: { id: "binding", generation: 3, desiredState: "STOPPED", observedState: "STOPPED" }, operation };
const backend = { sandboxId: "binding", state: "stopped", imageDigest: preset.imageDigest,
  helperDigest: recipe.guestImage.helperSha256, profile: preset.profile,
  workspaceRoot: "/workspace", guestUser: "sandbox", memoryBytes: preset.limits.memoryBytes,
  cpuMillis: preset.limits.cpuMillis, pids: preset.limits.pids, diskBytes: preset.limits.diskBytes,
  storageDriver: recipe.storage.driver, privateNetwork: true, restrictedProject: true,
  unprivileged: true, bootId: null } as const;

async function invoke(input: object, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, source], { stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe", stderr: "pipe", env: { ...process.env, DATABASE_URL: "", ...env } });
  const [status, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, stdout, stderr };
}

test("receipt verifier snapshots the stopped fixture and computes a pinned backend digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "incus-receipt-"));
  const dbPath = join(root, "db");
  const configPath = join(root, "connection.json");
  const presetDigest = await sandboxPresetDigest(preset);
  const before = { processId: `${oldProcess.pid}:${oldProcess.startTicks}`, durable, backend };
  const exactRequest = { ...request, deadlineMs: Date.now() + 60_000,
    beforeDigest: observationDigest(before as unknown as RecoveryObservation) };
  const name = resourceName(scope.connectionId, exactRequest.bindingId);
  let wrongBackend = false;
  let backendGets = 0;
  const server = createServer({ cert: certificates.read("server-cert.pem"),
    key: certificates.read("server-key.pem"), ca: certificates.read("client-ca-cert.pem"),
    requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
    backendGets++;
    const path = new URL(incoming.url!, "https://127.0.0.1").pathname;
    let metadata: object;
    if (path === `/1.0/instances/${name}`) metadata = {
      name, type: "container", status: wrongBackend ? "Running" : "Stopped",
      profiles: [recipe.profile.name], config: {
        "user.ezharness.managed_by": "ezharness-incus-sandbox",
        "user.ezharness.connection_id": scope.connectionId,
        "user.ezharness.sandbox_id": exactRequest.bindingId,
        "user.ezharness.profile": preset.profile,
        "user.ezharness.preset_id": preset.id,
        "volatile.base_image": preset.imageDigest,
        "limits.memory": String(preset.limits.memoryBytes),
        "limits.cpu": String(Math.ceil(preset.limits.cpuMillis / 1000)),
        "limits.cpu.allowance": `${preset.limits.cpuMillis}ms/1000ms`,
        "limits.processes": String(preset.limits.pids),
      }, expanded_config: { "security.privileged": "false", "security.idmap.isolated": "true" },
      devices: { root: { type: "disk", path: "/", pool: recipe.storage.name,
        size: String(preset.limits.diskBytes) } },
      expanded_devices: { eth0: { type: "nic", network: recipe.network.name,
        "security.port_isolation": "true" }, root: recipe.profile.devices.root } };
    else if (path === `/1.0/projects/${recipe.project.name}`) metadata = {
      name: recipe.project.name, config: recipe.project.config };
    else if (path === `/1.0/storage-pools/${recipe.storage.name}`) metadata = {
      name: recipe.storage.name, driver: recipe.storage.driver };
    else { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ type: "sync", status_code: 200, metadata }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const serverCertificatePem = certificates.read("server-cert.pem");
    const transportConnection = { endpoint: `https://127.0.0.1:${port}`, serverCertificatePem,
      project: recipe.project.name, clientCertificatePem: certificates.read("client-cert.pem"),
      privateKeyPem: certificates.read("client-key.pem") };
    const context = { scope: { installationId: scope.installationId,
      releaseId: scope.releaseId, connectionId: scope.connectionId },
    connection: { revision: 2, project: recipe.project.name, serverCertificatePem,
      configuration: { profile: recipe.profile.name, helperVersion: "0.1.0", guestUser: "sandbox" } },
    preset, presetDigest, effectiveSettingsDigest: "a".repeat(64), recipe };
    await writeFile(configPath, JSON.stringify({ context, transportConnection }), { mode: 0o600 });
    const db = new PGlite(dbPath);
    await db.waitReady;
    await db.exec(`
      CREATE TABLE incus_qualification_runs (run_id TEXT, nonce TEXT, deadline_at TIMESTAMPTZ,
        scope JSONB, fixture_operation_id TEXT, binding_id TEXT, generation INTEGER,
        connection_revision INTEGER, last_operation_id TEXT, before_digest TEXT,
        before_observation JSONB, old_process_identity JSONB, state TEXT);
      CREATE TABLE incus_qualification_fixtures (operation_id TEXT, project_id TEXT,
        binding_id TEXT, connection_revision INTEGER, installation_id TEXT, release_id TEXT,
        connection_id TEXT, preset_id TEXT, preset_digest TEXT, effective_settings_digest TEXT);
      CREATE TABLE projects (id TEXT, purpose TEXT);
      CREATE TABLE sandbox_bindings (id TEXT, project_id TEXT, current_operation_id TEXT,
        resource_key TEXT, desired_state TEXT, observed_state TEXT, generation INTEGER,
        provider_installation_id TEXT, provider_release_id TEXT, connection_id TEXT,
        connection_revision INTEGER, preset_id TEXT, preset_digest TEXT,
        effective_settings_digest TEXT);
      CREATE TABLE provider_sandbox_operations (id TEXT, binding_id TEXT, kind TEXT,
        state TEXT, generation INTEGER, provider_operation_id TEXT, error_code TEXT,
        created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, reconcile_order BIGINT);
    `);
    await db.query("INSERT INTO projects VALUES ('project', 'incus-qualification')");
    await db.query(`INSERT INTO sandbox_bindings VALUES ('binding','project','operation','binding',
      'STOPPED','STOPPED',3,'installation','release','connection',2,$1,$2,$3)`,
    [preset.id, presetDigest, context.effectiveSettingsDigest]);
    await db.query(`INSERT INTO incus_qualification_fixtures VALUES
      ('fixture','project','binding',2,'installation','release','connection',$1,$2,$3)`,
    [preset.id, presetDigest, context.effectiveSettingsDigest]);
    await db.query(`INSERT INTO provider_sandbox_operations VALUES
      ('operation','binding','STOP','SUCCEEDED',3,'provider-operation',NULL,$1,$2,1)`,
    [new Date(operation.createdAt), new Date(operation.updatedAt)]);
    await db.query(`INSERT INTO incus_qualification_runs VALUES
      ('run','nonce',$1,$2,'fixture','binding',3,2,'operation',$3,$4,$5,'AWAITING_RESTART')`,
    [new Date(exactRequest.deadlineMs), JSON.stringify(scope), exactRequest.beforeDigest,
      JSON.stringify(before), JSON.stringify(oldProcess)]);
    await db.close();
    const env = { EZCORP_INCUS_SUPERVISOR_DB_PATH: dbPath,
      EZCORP_INCUS_RECEIPT_CONFIG: configPath };
    expect(await invoke({ phase: "readiness" }, env)).toMatchObject({
      status: 0, stdout: '{"ready":"receipt.v1"}\n',
    });
    const expectedPin = { scope, connectionRevision: 2, presetDigest,
      effectiveSettingsDigest: context.effectiveSettingsDigest,
      imageFingerprint: preset.imageDigest, helperSha256: recipe.guestImage.helperSha256 };
    expect(await invoke({ phase: "readiness", expectedPin }, env)).toMatchObject({
      status: 0, stdout: '{"ready":"receipt.v1"}\n',
    });
    // The new phase must not treat legacy structural readiness as dynamic evidence.
    expect((await invoke({ phase: "admissionReadiness", expectedPin }, env)).status).not.toBe(0);
    expect((await invoke({ phase: "admissionReadiness", expectedPin: { ...expectedPin, extra: true } }, env)).status).not.toBe(0);
    expect((await invoke({ phase: "readiness", expectedPin: {
      ...expectedPin, scope: { ...scope, releaseId: "approved-new-release" },
    } }, env)).status).not.toBe(0);
    for (const changed of [
      ...["installationId", "releaseId", "connectionId", "presetId"].map(key => ({
        ...expectedPin, scope: { ...scope, [key]: "wrong" },
      })),
      { ...expectedPin, connectionRevision: 1 },
      ...["presetDigest", "effectiveSettingsDigest", "imageFingerprint", "helperSha256"]
        .map(key => ({ ...expectedPin, [key]: "f".repeat(64) })),
      { ...expectedPin, extra: true }, { ...expectedPin, scope: { ...scope, extra: true } },
      { ...expectedPin, connectionRevision: 0 }, { ...expectedPin, connectionRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...expectedPin, helperSha256: "malformed" }, { ...expectedPin, scope: { ...scope, releaseId: "../wrong" } },
      null, [],
    ]) expect((await invoke({ phase: "readiness", expectedPin: changed }, env)).status).not.toBe(0);
    expect(backendGets).toBe(0);
    const captured = await invoke({ phase: "snapshot", request: exactRequest }, env);
    expect(captured.status).toBe(0);
    const snapshot = JSON.parse(captured.stdout).snapshot;
    expect(snapshot.durable).toEqual(durable);
    const payload = { ...exactRequest, action: undefined, version: 1,
      oldProcess, newProcess };
    const verified = await invoke({ phase: "verify", payload, snapshot }, env);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout).afterDigest).toBe(observationDigest({
      processId: `${newProcess.pid}:${newProcess.startTicks}`, durable, backend,
    } as unknown as RecoveryObservation));
    expect(JSON.parse(verified.stdout).afterDigest).not.toBe("f".repeat(64));
    for (const changed of [
      { ...payload, nonce: "wrong" },
      { ...payload, bindingId: "other" },
      { ...payload, newProcess: oldProcess },
    ]) expect((await invoke({ phase: "verify", payload: changed, snapshot }, env)).status).not.toBe(0);
    wrongBackend = true;
    expect((await invoke({ phase: "verify", payload, snapshot }, env)).status).not.toBe(0);
    wrongBackend = false;
    await chmod(configPath, 0o644);
    expect((await invoke({ phase: "verify", payload, snapshot }, env)).status).not.toBe(0);
    expect((await invoke({ phase: "readiness" }, env)).status).not.toBe(0);
    await chmod(configPath, 0o600);
    const changedDb = new PGlite(dbPath);
    await changedDb.waitReady;
    await changedDb.exec("UPDATE projects SET purpose = 'user' WHERE id = 'project'");
    await changedDb.close();
    expect((await invoke({ phase: "snapshot", request: exactRequest }, env)).status).not.toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);


test("qualification factory checks trusted pins through Unix, Python and actual receipt before CREATE", async () => {
  const root = await mkdtemp(join(tmpdir(), "incus-selected-readiness-"));
  const socket = join(root, "control.sock");
  const configPath = join(root, "receipt.json");
  const presetDigest = await sandboxPresetDigest(preset);
  const selected = { connection: { revision: 2 }, preset, presetDigest,
    effectiveSettingsDigest: "b".repeat(64), helperDigest: recipe.guestImage.helperSha256 } as never;
  const context = { scope: { installationId: scope.installationId,
    releaseId: "old-release", connectionId: "old-connection" },
    connection: { revision: 2, project: recipe.project.name, serverCertificatePem: certificates.read("server-cert.pem") },
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64), recipe };
  const transportConnection = { project: recipe.project.name, serverCertificatePem: certificates.read("server-cert.pem") };
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyPath = join(root, "key.pem");
  await writeFile(keyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ context, transportConnection }), { mode: 0o600 });
  const faultPath = join(import.meta.dir, "incus-qualification-fault-authorize.py");
  const faultConfigPath = join(root, "fault.json");
  const faultConfig = { endpoint: "https://unused.example", project: recipe.project.name,
    serverCertificateSha256: "a".repeat(64), clientCertificate: keyPath, clientKey: keyPath,
    scope: { ...scope, releaseId: "old-release", connectionId: "old-connection" } };
  await writeFile(faultConfigPath, JSON.stringify(faultConfig), { mode: 0o600 });
  const supervisor = join(import.meta.dir, "incus-qualification-supervisor.py");
  const python = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("actual_supervisor",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.Supervisor(sys.argv[2],["true"],os.getuid(),os.getgid(),sys.argv[3],["true"],[sys.argv[4],sys.argv[5]],enforce_distinct_uid=False)
s.fault_authority_command=[sys.executable,sys.argv[6],"--config",sys.argv[8]]
from pathlib import Path
if Path(sys.argv[7]).exists(): s.claimed={"request":{"runId":"matching"}}
message=json.load(sys.stdin)
try:
 if message.get("action")=="readiness": print(json.dumps(s.readiness(message)))
 elif message.get("action")=="receipt":
  assert s.claimed is not None
  print(json.dumps({"receipt":{"payload":{"runId":message["runId"]},"signature":"test receipt boundary, not an attestation"}}))
 else: raise ValueError("unexpected test boundary")
except ValueError: print(json.dumps({"error":"selected readiness denied"}))`;
  const claimedPath = join(root, "claimed");
  const messages: unknown[] = [];
  const server = createUnixServer(connection => {
    let raw = "";
    connection.on("data", async chunk => {
      raw += chunk.toString();
      if (!raw.includes("\n")) return;
      messages.push(JSON.parse(raw));
      const child = Bun.spawn(["python3", "-B", "-c", python, supervisor, socket, keyPath, process.execPath, source, faultPath, claimedPath, faultConfigPath], {
        stdin: new Blob([raw]), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, DATABASE_URL: "", EZCORP_INCUS_SUPERVISOR_DB_PATH: join(root, "unused-db"),
          EZCORP_INCUS_RECEIPT_CONFIG: configPath },
      });
      const [status, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(error).toBe(""); expect(status).toBe(0); connection.end(out);
    });
  });
  const env = { EZCORP_INCUS_CONTROL_PROBE_ROOT: root, EZCORP_INCUS_SUPERVISOR_SOCKET: socket,
    EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID: "reviewed-project",
    EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF: `registry.example/proof@sha256:${"a".repeat(64)}`,
    EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: publicKey };
  const configReady = spyOn(IncusLiveProbeFixtureService.prototype, "readyConfig").mockResolvedValue({
    cases: Object.fromEntries(["unsupported", "missingControl", "drift", "unqualified"]
      .map(kind => [kind, { projectId: `probe-${kind}`, canaryPath: `/private/${kind}` }])), unqualifiedPresetId: "unused" } as never);
  let creates = 0;
  const create = spyOn(IncusHostLiveWitness.prototype, "createFixture").mockImplementation(async () => {
    creates++; throw new Error("CREATE boundary reached");
  });
  const previous = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  const ready = (input: Parameters<typeof incusHostLiveWitnessReady>[0]) => incusHostLiveWitnessReady({
    ...input, env, terminalRelease: async () => {} });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = root;
    // Old structural readiness is deliberately not a selected-authority proof.
    expect(await ready({})).toBe(true);
    await expect(createIncusQualificationWitness(scope, "stale", {} as never, { selected, ready }))
      .rejects.toThrow("selected operator pins");
    expect(creates).toBe(0); expect(configReady).not.toHaveBeenCalled();
    context.scope = { installationId: scope.installationId, releaseId: scope.releaseId, connectionId: scope.connectionId };
    await writeFile(configPath, JSON.stringify({ context, transportConnection }), { mode: 0o600 });
    await expect(createIncusQualificationWitness(scope, "stale-fault", {} as never, { selected, ready }))
      .rejects.toThrow("selected operator pins");
    expect(creates).toBe(0); expect(configReady).not.toHaveBeenCalled();
    faultConfig.scope = scope;
    await writeFile(faultConfigPath, JSON.stringify(faultConfig), { mode: 0o600 });
    const witness = await createIncusQualificationWitness(scope, "matching", {} as never, { selected, ready });
    await expect(witness.createFixture(scope, preset, "qual-primary-matching", true)).rejects.toThrow("CREATE boundary reached");
    expect(creates).toBe(1); expect(configReady).toHaveBeenCalledWith(scope, "matching");
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({ version: 1, action: "readiness", expectedPin: {
      scope, connectionRevision: 2, presetDigest, imageFingerprint: preset.imageDigest,
      helperSha256: recipe.guestImage.helperSha256 } });
    expect(JSON.stringify(messages)).not.toContain("BEGIN CERTIFICATE");
    expect(JSON.stringify(messages)).not.toContain("PRIVATE KEY");
    await writeFile(claimedPath, "claimed test checkpoint", { mode: 0o600 });
    expect(await ready({})).toBe(false); // Actual Python active-run fence stays closed.
    const beforeResume = messages.length;
    let recorded = false;
    await resumePendingIncusQualification({ db: {} as never,
      checkpoints: { pending: async () => ({ scope, runId: "matching", nonce: "nonce" }) as never,
        fail: async () => { throw new Error("continuation unexpectedly failed"); } },
      qualifications: { authorizeFixture: async () => selected,
        recordVerified: async () => { recorded = true; return {} as never; } },
      resume: async (_options, seenScope, seenPreset, claim) => {
        expect(seenScope).toEqual(scope); expect(seenPreset).toEqual(preset);
        expect(claim).toEqual({ runId: "matching", nonce: "nonce" });
        // This verifies the continuation reaches the receipt IPC boundary. The
        // server's receipt is a test double, not signed qualification evidence.
        const receipt = await requestIncusSupervisorReceipt(socket, "matching", "nonce", "a".repeat(64), Date.now() + 30_000);
        expect(receipt.payload.runId).toBe("matching");
        return {} as never;
      }, releaseTerminal: async () => {} });
    expect(recorded).toBe(true);expect(creates).toBe(1);
    expect(messages.slice(beforeResume)).toEqual([{ version: 1, action: "receipt",
      runId: "matching", nonce: "nonce", afterDigest: "a".repeat(64) }]);

  } finally {
    create.mockRestore();configReady.mockRestore();
    if (previous === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
    else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
