import { afterAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { startFactoryPrivateHttps } from "./private-https";
import { createFactoryHostStopClient, parseFactoryHostStopReceipt } from "./host-stop-client";
import { createFactoryHostStopRouteHandler, loadFactoryHostSigningKey, type FactoryHostStopCommand } from "./runner/host-stop-service";
import { factoryAttemptWorkerId, type FactoryUnsignedPhysicalStopReceipt } from "./runner/attempt-runtime";
import { validateFactoryStopReceipt, type FactoryJournalHostKey } from "./journal-validation";
import { factoryStopHostKeyMap, type FactoryTaskStopRequest } from "./task-stops";
import { certificates, type Certificates } from "../__tests__/helpers/factory-certificates";
import { privateHttpsCall } from "../__tests__/helpers/factory-private-https-client";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const hostId = "transport-host";
const attemptId = "transport-attempt";
const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
const second = generateKeyPairSync("rsa", { modulusLength: 2048 });

function stopRequest(overrides: Partial<FactoryTaskStopRequest> = {}): FactoryTaskStopRequest {
  return {
    cancelReference: { tenantId: "tenant-a", projectId: "project-a", logicalRunId: "run-a", interpreterId: "root", commandId: "cancel-a" },
    attemptId, reservationId: "transport-reservation", workerId: factoryAttemptWorkerId(attemptId),
    holderGeneration: 3, allocationGeneration: 4, hostId, reason: "cancelled", source: "sealed-launch",
    ...overrides,
  } as FactoryTaskStopRequest;
}

function unsigned(command: FactoryHostStopCommand, stoppedAtMs: number): FactoryUnsignedPhysicalStopReceipt {
  return { schemaVersion: "factory.physical-stop.v1", attemptId: command.attemptId, reservationId: command.reservationId, workerId: command.workerId, holderGeneration: command.holderGeneration, allocationGeneration: command.allocationGeneration, processGroupAbsent: true, stoppedAtMs, reason: command.reason, hostId: command.hostId };
}

async function keyMaterial(root: string, name: string, key: typeof first, keyId: string) {
  const privateKeyPath = join(root, `${name}.pem`);
  const keyIdPath = join(root, `${name}.id`);
  await writeFile(privateKeyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  await writeFile(keyIdPath, `${keyId}\n`, { mode: 0o600 });
  return { hostId, privateKeyPath, keyIdPath };
}

async function clientSecrets(root: string, certs: Certificates) {
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  // The host route authorizes by peer certificate only; the shared transport
  // still requires a non-empty token file, so the value is deliberately inert.
  await writeFile(paths.serviceTokenPath, "unused-by-the-host-stop-route");
  return paths;
}

test("the host signs a real mutual-TLS stop, rotates its key without a restart, and refuses every other caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-stop-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const signingKey = await keyMaterial(root, "host", first, "transport-key-1");
  let stops: FactoryHostStopCommand[] = [];
  let stoppedAtMs = 1_700_000_000_000;
  let supervisorFault: Error | undefined;
  let drift = false;
  const supervisor = {
    async stop(command: FactoryHostStopCommand) {
      stops.push(command);
      if (supervisorFault) throw supervisorFault;
      return unsigned(drift ? { ...command, attemptId: "another-attempt" } : command, stoppedAtMs);
    },
  };
  const handler = createFactoryHostStopRouteHandler({ hostId, allowedPeers: ["tenant-a"], supervisor, signingKey, stopTimeoutMs: 2_000 });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: handler });
  try {
    const paths = await clientSecrets(root, certs);
    const client = await createFactoryHostStopClient({ baseUrl: service.url, tls: paths, serverName: "localhost", hostId });
    const request = stopRequest();

    const receipt = await client.stop(request, AbortSignal.timeout(10_000));
    expect(stops).toHaveLength(1);
    expect(receipt).toMatchObject({ hostId, hostKeyId: "transport-key-1", processGroupAbsent: true, reason: "cancelled", attemptId });
    expect(receipt.receiptDigest).toBe(`sha256:${createHash("sha256").update(canonicalJson(unsigned(stops[0]!, stoppedAtMs))).digest("hex")}`);

    // The signature really verifies against the configured host key, and the
    // product never held the private half.
    const configured = factoryStopHostKeyMap([{ hostId, hostKeyId: "transport-key-1", publicKey: first.publicKey }]);
    expect(validateFactoryStopReceipt(request, receipt, configured)).toEqual({ ok: true });

    // Rotation: replacing the key files rotates the next signature with no
    // restart, and the retired key no longer verifies the new receipt.
    await writeFile(signingKey.privateKeyPath, second.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    await writeFile(signingKey.keyIdPath, "transport-key-2\n", { mode: 0o600 });
    stoppedAtMs += 1_000;
    const rotated = await client.stop(request, AbortSignal.timeout(10_000));
    expect(rotated.hostKeyId).toBe("transport-key-2");
    expect(validateFactoryStopReceipt(request, rotated, configured)).toMatchObject({ ok: false, issues: [{ code: "factory_stop_receipt_key_unknown" }] });
    const rotatedKeys: ReadonlyMap<string, FactoryJournalHostKey> = factoryStopHostKeyMap([{ hostId, hostKeyId: "transport-key-2", publicKey: second.publicKey }]);
    expect(validateFactoryStopReceipt(request, rotated, rotatedKeys)).toEqual({ ok: true });
    // The retained-trust policy: while both keys are configured, a receipt from
    // either is admissible, so a receipt in flight across a rotation still settles.
    const both = factoryStopHostKeyMap([{ hostId, hostKeyId: "transport-key-1", publicKey: first.publicKey }, { hostId, hostKeyId: "transport-key-2", publicKey: second.publicKey }]);
    expect(validateFactoryStopReceipt(request, receipt, both)).toEqual({ ok: true });
    expect(validateFactoryStopReceipt(request, rotated, both)).toEqual({ ok: true });

    // A foreign client certificate is refused before any stop is attempted.
    stops = [];
    const foreign = await privateHttpsCall(`${service.url}/v1/host/stops`, certs, { method: "POST", certificate: "foreign", body: Buffer.from(JSON.stringify({ attemptId, reservationId: request.reservationId, workerId: request.workerId, holderGeneration: 3, allocationGeneration: 4, hostId, reason: "cancelled" })), headers: { "content-type": "application/json", "x-ezcorp-factory-version": "1" } });
    expect(foreign.status).toBe(401);
    expect(stops).toEqual([]);

    // A gateway cannot address another host through this one, nor invent fields.
    for (const [body, status] of [
      [{ attemptId, reservationId: request.reservationId, workerId: request.workerId, holderGeneration: 3, allocationGeneration: 4, hostId: "other-host", reason: "cancelled" }, 403],
      [{ attemptId, reservationId: request.reservationId, workerId: request.workerId, holderGeneration: 3, allocationGeneration: 4, hostId, reason: "vaporised" }, 400],
      [{ attemptId, reservationId: request.reservationId, workerId: request.workerId, holderGeneration: 0, allocationGeneration: 4, hostId, reason: "cancelled" }, 400],
      [{ attemptId, reservationId: request.reservationId, workerId: request.workerId, holderGeneration: 3, allocationGeneration: 4, hostId, reason: "cancelled", extra: 1 }, 400],
    ] as const) {
      const refused = await privateHttpsCall(`${service.url}/v1/host/stops`, certs, { method: "POST", body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json", "x-ezcorp-factory-version": "1" } });
      expect({ body, status: refused.status }).toEqual({ body, status });
    }
    expect(stops).toEqual([]);
    const wrongPath = await privateHttpsCall(`${service.url}/v1/host/other`, certs, { method: "POST", body: Buffer.from("{}"), headers: { "content-type": "application/json", "x-ezcorp-factory-version": "1" } });
    expect(wrongPath.status).toBe(404);
    const wrongVersion = await privateHttpsCall(`${service.url}/v1/host/stops`, certs, { method: "POST", body: Buffer.from("{}"), headers: { "content-type": "application/json" } });
    expect(wrongVersion.status).toBe(400);

    // A supervisor that cannot confirm absence yields no receipt at all. The two
    // refusals below share a status and mean entirely different things, so the
    // caller is told which one it got: one is a runtime that would not confirm,
    // the other is a receipt that does not answer the command that asked.
    supervisorFault = new Error("Factory worker absence is not physically confirmed after stop.");
    await expect(client.stop(request, AbortSignal.timeout(10_000)))
      .rejects.toMatchObject({ code: "factory_host_stop_refused", status: 409, hostError: "stop_uncertain" });
    supervisorFault = undefined;

    // A host that answers about a different attempt is a conflict, not a proof.
    drift = true;
    await expect(client.stop(request, AbortSignal.timeout(10_000)))
      .rejects.toMatchObject({ code: "factory_host_stop_refused", status: 409, hostError: "conflict" });
    drift = false;

    // The client refuses to address a host this endpoint does not serve.
    await expect(client.stop(stopRequest({ hostId: "elsewhere" }), AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "factory_task_stop_pool_mismatch" });
  } finally { service.stop(); }
}, 120_000);

test("refuses malformed host signing material and every non-receipt reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-stop-material-"));
  directories.push(root);
  const good = await keyMaterial(root, "good", first, "material-key");
  expect((await loadFactoryHostSigningKey(good)).hostKeyId).toBe("material-key");
  await writeFile(good.keyIdPath, "   \n");
  await expect(loadFactoryHostSigningKey(good)).rejects.toThrow("key id is invalid");
  await writeFile(good.keyIdPath, "material-key");
  await writeFile(good.privateKeyPath, "not a pem key");
  await expect(loadFactoryHostSigningKey(good)).rejects.toThrow("signing key is invalid");
  await writeFile(good.privateKeyPath, "x".repeat(17 * 1024));
  await expect(loadFactoryHostSigningKey(good)).rejects.toThrow("oversized");

  const supervisor = { async stop(command: FactoryHostStopCommand) { return unsigned(command, 1); } };
  expect(() => createFactoryHostStopRouteHandler({ hostId, allowedPeers: [], supervisor, signingKey: good })).toThrow("authorized peer");
  expect(() => createFactoryHostStopRouteHandler({ hostId, allowedPeers: ["tenant-a"], supervisor, signingKey: { ...good, hostId: "other" } })).toThrow("authorized peer");

  const valid = { schemaVersion: "factory.physical-stop.v1", attemptId, reservationId: "r", workerId: "w", holderGeneration: 1, allocationGeneration: 1, processGroupAbsent: true, stoppedAtMs: 5, reason: "cancelled", hostId, hostKeyId: "k", hostSignature: "s", receiptDigest: "d" };
  expect(parseFactoryHostStopReceipt(valid, hostId)).toMatchObject({ attemptId, hostId });
  for (const broken of [
    null, "receipt", [valid], { ...valid, extra: 1 }, { ...valid, schemaVersion: "factory.physical-stop.v2" },
    { ...valid, processGroupAbsent: false }, { ...valid, reason: "vaporised" }, { ...valid, hostId: "other" },
    { ...valid, holderGeneration: 0 }, { ...valid, stoppedAtMs: -1 }, { ...valid, attemptId: "" },
  ]) expect(() => parseFactoryHostStopReceipt(broken, hostId)).toThrow("factory_task_stop_proof_invalid");
});
