import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { handleFencedCleanupPhase } from "../../scripts/incus/incus-create-noeffect-recovery";
import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import recipeValue from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { resourceName } from "./incus-transport/lifecycle";
import { observeFencedCleanup, type FencedCleanupPins } from "./incus-fenced-cleanup-observer";
const certs = makeTestCertificates();
afterAll(() => certs.dispose());
const recipe = recipeValue as IncusSetupRecipe;
const preset = INCUS_PRESETS[0]!;
const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: preset.id };
const target = { scope, fixtureOperationId: "fixture", bindingId: "binding", operationId: "operation", generation: 1, connectionRevision: 1 };
const connection = { endpoint: "https://127.0.0.1:8443", project: recipe.project.name, serverCertificatePem: certs.read("server-cert.pem"), clientCertificatePem: certs.read("client-cert.pem"), privateKeyPem: certs.read("client-key.pem") };
const context = { scope: { installationId: scope.installationId, releaseId: scope.releaseId, connectionId: scope.connectionId }, connection: { revision: 1, project: connection.project, serverCertificatePem: connection.serverCertificatePem, configuration: { profile: recipe.profile.name, helperVersion: "0.1.3", guestUser: "sandbox" } }, preset, presetDigest: await sandboxPresetDigest(preset), effectiveSettingsDigest: "a".repeat(64), recipe };
const pins: FencedCleanupPins = { installationGeneration: 4, releaseDigest: "a".repeat(64), grantsDigest: "b".repeat(64), endpoint: connection.endpoint, project: connection.project, providerOperationId: "incus-setPower-11111111-1111-1111-1111-111111111111", nativeOperationId: "11111111-1111-1111-1111-111111111111", operationTag: "tag", payloadHash: "c".repeat(64), presetDigest: context.presetDigest, effectiveSettingsDigest: context.effectiveSettingsDigest, imageFingerprint: preset.imageDigest, helperVersion: "0.1.3", serverCertificateSha256: createHash("sha256").update(new X509Certificate(connection.serverCertificatePem).raw).digest("hex") };
const instance = { name: resourceName(scope.connectionId, target.bindingId), type: "container", status: "Stopped", profiles: [recipe.profile.name], config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": scope.connectionId, "user.ezharness.sandbox_id": target.bindingId, "user.ezharness.profile": preset.profile, "user.ezharness.preset_id": preset.id, "volatile.base_image": preset.imageDigest, "user.ezharness.operation_id": pins.operationTag, "user.ezharness.generation": "2" } };
function backend(change: (value: typeof instance) => void = () => {}, nativeStatus = 404, operations: unknown = { running: [] }, moving = false) {
 const paths: string[] = []; let reads = 0;
 const fetcher = async (url: string, init: RequestInit) => { expect(init.method).toBe("GET"); const path = new URL(url).pathname; paths.push(path);
 if (path.startsWith("/1.0/instances/")) { const value = structuredClone(instance); change(value); if (moving && reads++) value.config["user.ezharness.generation"] = "3"; return Response.json({ type: "sync", status_code: 200, metadata: value }); }
 if (path === "/1.0/operations") return Response.json({ type: "sync", status_code: 200, metadata: operations });
 return Response.json({ type: "sync", status_code: nativeStatus, metadata: {} }, { status: nativeStatus }); };
 return { paths, fetcher };
}
test("sealed observer uses exactly four read requests and reports provider generation independently", async () => { const b = backend(); expect(await observeFencedCleanup({ resolveForHost: async () => connection }, context, target, pins, b.fetcher as never)).toEqual({ instanceState: "stopped", nativeOperationAbsent: true, activeOperations: [], providerGeneration: 2, pins }); expect(b.paths).toEqual([`/1.0/instances/${instance.name}`, `/1.0/operations/${pins.nativeOperationId}`, "/1.0/operations", `/1.0/instances/${instance.name}`]); });
for (const [label, change] of Object.entries({ running: (v: typeof instance) => { v.status = "Running"; }, foreign: (v: typeof instance) => { v.config["user.ezharness.sandbox_id"] = "foreign"; }, image: (v: typeof instance) => { v.config["volatile.base_image"] = "wrong"; }, tag: (v: typeof instance) => { v.config["user.ezharness.operation_id"] = "wrong"; }, generation: (v: typeof instance) => { v.config["user.ezharness.generation"] = "0"; }, profile: (v: typeof instance) => { v.profiles = ["default"]; } })) test(`observer rejects ${label}`, async () => { const b = backend(change); await expect(observeFencedCleanup({ resolveForHost: async () => connection }, context, target, pins, b.fetcher as never)).rejects.toThrow("Incus lifecycle request failed"); });
for (const [label, b] of [["present native", backend(undefined, 200)], ["active operation", backend(undefined, 404, { running: ["native"] })], ["moving resource", backend(undefined, 404, undefined, true)]] as const) test(`observer rejects ${label}`, async () => { await expect(observeFencedCleanup({ resolveForHost: async () => connection }, context, target, pins, b.fetcher as never)).rejects.toThrow(); });
test("sealed endpoint and certificate changes fail before backend reads", async () => { const b = backend(); await expect(observeFencedCleanup({ resolveForHost: async () => ({ ...connection, endpoint: "https://foreign:8443" }) }, context, target, pins, b.fetcher as never)).rejects.toThrow(); await expect(observeFencedCleanup({ resolveForHost: async () => connection }, context, target, { ...pins, serverCertificateSha256: "0".repeat(64) }, b.fetcher as never)).rejects.toThrow("sealed target pins changed"); expect(b.paths).toEqual([]); });

test("producer refuses unknown phases, caller observation fields, and unconfigured signers", async () => {
  await expect(handleFencedCleanupPhase({ phase: "write", target })).rejects.toThrow("phase invalid");
  await expect(handleFencedCleanupPhase({ phase: "backend", target: { ...target, action: "recover-fenced-cleanup", pins }, observations: {} })).rejects.toThrow("phase fields changed");
  await expect(handleFencedCleanupPhase({ phase: "durable", target })).rejects.toThrow("action required");
  const old = process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64;
  delete process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64;
  try { await expect(handleFencedCleanupPhase({ phase: "apply", publicKeyPem: "caller", receipt: {} })).rejects.toThrow("configured supervisor signer"); }
  finally { if (old !== undefined) process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64 = old; }
});
test("producer sealed config rejects altered scope and public pins before credentials or network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fenced-sealed-"));
  const path = join(directory, "policy.json");
  const old = process.env.EZCORP_INCUS_FENCED_CLEANUP_CONFIG;
  process.env.EZCORP_INCUS_FENCED_CLEANUP_CONFIG = path;
  const frame = { phase: "backend", target: { ...target, action: "recover-fenced-cleanup", pins } };
  try {
    await writeFile(path, JSON.stringify({ version: 1, action: "recover-fenced-cleanup", target: { ...target, operationId: "foreign" }, pins, context, observation: { project: pins.project, instance: instance.name, oldCertificateSha256: "a".repeat(64) }, operatorClientCertificateFile: "/not-read", operatorPrivateKeyFile: "/not-read" }), { mode: 0o600 });
    await expect(handleFencedCleanupPhase(frame)).rejects.toThrow("sealed policy changed");
    await writeFile(path, JSON.stringify({ version: 1, action: "recover-fenced-cleanup", target, pins: { ...pins, imageFingerprint: "0".repeat(64) }, context, observation: { project: pins.project, instance: instance.name }, operatorClientCertificateFile: "/not-read", operatorPrivateKeyFile: "/not-read" }));
    await expect(handleFencedCleanupPhase(frame)).rejects.toThrow("sealed policy changed");
    const trusted = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const foreign = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const previous = process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64;
    process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64 = Buffer.from(trusted).toString("base64");
    try { await expect(handleFencedCleanupPhase({ phase: "apply", publicKeyPem: foreign, receipt: {} })).rejects.toThrow("configured supervisor signer"); }
    finally { if (previous === undefined) delete process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64; else process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64 = previous; }
  } finally { if (old === undefined) delete process.env.EZCORP_INCUS_FENCED_CLEANUP_CONFIG; else process.env.EZCORP_INCUS_FENCED_CLEANUP_CONFIG = old; await rm(directory, { recursive: true }); }
});
