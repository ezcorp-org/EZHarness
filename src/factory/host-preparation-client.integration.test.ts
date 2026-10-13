import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequest, BuildResult, Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { factoryLaunchLease, factoryLaunchPeerTenants, factoryLaunchTenant } from "../__tests__/helpers/factory-attempt-launch-fixture";
import { digestObject } from "../extensions/v4/blobs";
import { FactoryHostLaunchRefusal } from "./host-launch-client";
import { createFactoryHostPreparationClient, FACTORY_HOST_PREPARATION_CLIENT_TIMEOUT_MS } from "./host-preparation-client";
import { startFactoryPrivateHttps } from "./private-https";
import { createFactoryHostLaunchRouteHandler, FACTORY_HOST_PREPARATION_TIMEOUT_MS } from "./runner/host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./runner/host-launch-supervisor";

/**
 * C05 "Prepare a bound package for dispatch" (W4H-26), across a real mutual-TLS host boundary: the
 * product sends the release source, the supervisor builds it in its own store, and the product keeps
 * the artifacts only when they digest to the artifact the host names.
 */
const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const hostId = factoryLaunchLease.hostId;
const source: WorkspaceFiles = { "extension.ts": "export {};" };
const artifacts: WorkspaceFiles = { "extension.ts": "export {};", ".runner/recipe.json": "{}" };

/** A host store that builds the source into `stored`, answering whatever artifact digest the case chooses. */
class StoreRunner {
  builds: BuildRequest[] = [];
  constructor(private readonly stored: WorkspaceFiles, private readonly named = digestObject(stored), private readonly state: BuildResult["state"] = "succeeded") {}
  async build(input: BuildRequest): Promise<BuildResult> {
    this.builds.push(input);
    return { operationId: input.operationId, state: this.state, sourceDigest: input.sourceDigest, ...(this.state === "succeeded" ? { artifactDigest: this.named } : {}), imageDigest: "image@sha256:x", diagnostics: [], evidence: {} as never };
  }
  async collectArtifacts(): Promise<WorkspaceFiles> { return structuredClone(this.stored); }
}

async function host(runner: StoreRunner, handle?: Parameters<typeof startFactoryPrivateHttps>[0]["handle"]) {
  const certs = await certificates(directories, "tenant-a");
  const root = await mkdtemp(join(tmpdir(), "factory-host-preparation-"));
  directories.push(root);
  const supervisor = createFactoryHostLaunchSupervisor({ runner: runner as unknown as Runner, hostId, broker: { invoke: async () => ({}) } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: handle ?? createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor, report: () => {} }) });
  const tls = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(tls.caPath, certs.ca);
  await writeFile(tls.certificatePath, certs.clientCert);
  await writeFile(tls.privateKeyPath, certs.clientKey);
  await writeFile(tls.serviceTokenPath, "unused-by-the-host-route");
  const client = await createFactoryHostPreparationClient({ baseUrl: service.url, serverName: "localhost", tls, tenantId: factoryLaunchTenant });
  return { service, client };
}

const request = (sourceDigest = filesDigest(source)): BuildRequest => ({ operationId: "build-1", sourceDigest, files: source, entrypoint: "extension.ts", limits: {} as never });

test("the host builds the bound source in its own store and the product keeps the artifacts that digest to the build", async () => {
  const runner = new StoreRunner(artifacts);
  const { service, client } = await host(runner);
  try {
    await expect(client.collectArtifacts(digestObject(artifacts))).rejects.toThrow("host_preparation_not_built");
    const result = await client.build(request());
    expect(result).toMatchObject({ state: "succeeded", artifactDigest: digestObject(artifacts), operationId: "build-1" });
    expect(runner.builds.map(build => build.sourceDigest)).toEqual([filesDigest(source)]);
    expect(await client.collectArtifacts(digestObject(artifacts))).toEqual(artifacts);
  } finally { service.stop(); }
}, 60_000);

test("a source that is not the digest it names is refused by the host, and nothing is built", async () => {
  const runner = new StoreRunner(artifacts);
  const { service, client } = await host(runner);
  try {
    const refusal = await client.build(request("0".repeat(64))).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FactoryHostLaunchRefusal);
    expect((refusal as FactoryHostLaunchRefusal).code).toBe("source_digest_mismatch");
    expect(runner.builds).toEqual([]);
  } finally { service.stop(); }
}, 60_000);

test("artifacts that do not digest to the artifact the host names are refused, and nothing is kept", async () => {
  const runner = new StoreRunner(artifacts, "e".repeat(64));
  const { service, client } = await host(runner);
  try {
    await expect(client.build(request())).rejects.toThrow("host_preparation_artifact_mismatch");
    await expect(client.collectArtifacts("e".repeat(64))).rejects.toThrow("host_preparation_not_built");
  } finally { service.stop(); }
}, 60_000);

test("a failed build is answered as it is and keeps nothing; an answer that is not a build is refused", async () => {
  const failing = await host(new StoreRunner(artifacts, digestObject(artifacts), "failed"));
  try {
    expect((await failing.client.build(request())).state).toBe("failed");
    await expect(failing.client.collectArtifacts(digestObject(artifacts))).rejects.toThrow("host_preparation_not_built");
  } finally { failing.service.stop(); }
  const odd = await host(new StoreRunner(artifacts), async () => ({ status: 200, body: Buffer.from(JSON.stringify({ result: { state: "succeeded" } })) }));
  try {
    await expect(odd.client.build(request())).rejects.toThrow("host_preparation_invalid");
  } finally { odd.service.stop(); }
}, 60_000);

test("the product waits longer than the host's own build bound", () => {
  expect(FACTORY_HOST_PREPARATION_CLIENT_TIMEOUT_MS).toBeGreaterThan(FACTORY_HOST_PREPARATION_TIMEOUT_MS);
});
