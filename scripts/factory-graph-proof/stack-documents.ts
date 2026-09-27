/**
 * Every JSON document the graph-proof stack writes under `secrets/`.
 *
 * Pure builders, so `stack.ts` writes exactly what
 * `src/factory/graph-proof-diagnostics.test.ts` classifies: every string leaf
 * of every document here must be a known secret or on the diagnostics
 * allowlist, and a new field fails that test until someone decides which.
 */
import { FACTORY_GUEST_BROKER_AUDIENCE } from "../../src/factory/runner/guest-broker-contract";
import { join } from "node:path";
import type { JsonValue } from "@ezcorp/factory-sdk";

export const TENANT = "tenant-01";
export const INSTALLATION = "installation-w19a";
export const HOST_ID = "host-w19a";
export const POOL_ID = "pool-w19a";
export const NAMESPACE = "tenant-01.factory";
export const SUPERVISOR_SUBJECT = "supervisor-w19a";
export const GUEST_BROKER_ISSUER = "w19a-proof";
export const MASTER_KEY_ID = "master-1";

/** Where the stack lives and what it listens on. Everything a document names. */
export interface StackLayout {
  readonly root: string;
  readonly poolDatabase: string;
  /** The pool database's URL, with its credentials: the one secret a document carries by value. */
  readonly poolUrl: string;
  readonly ports: {
    readonly pool: number;
    readonly hostService: number;
    readonly guestBroker: number;
    readonly temporalTls: number;
    readonly temporalHttp: number;
    readonly gateway: number;
    readonly privateService: number;
  };
  readonly runnerProfiles: Record<string, JsonValue>;
  readonly modelProvider?: { readonly provider: string; readonly model: string };
}

export const secretsDir = (layout: Pick<StackLayout, "root">) => join(layout.root, "secrets");
export const secretPath = (layout: Pick<StackLayout, "root">, name: string) => join(secretsDir(layout), name);
export const readinessPath = (layout: Pick<StackLayout, "root">, name: string) => join(layout.root, "readiness", name);
export const runnerRoot = (layout: Pick<StackLayout, "root">) => join(layout.root, "runner");

const tls = (layout: StackLayout, identity: "server" | "client" | "supervisor") => ({
  caPath: secretPath(layout, "ca.pem"),
  certificatePath: secretPath(layout, `${identity}.pem`),
  privateKeyPath: secretPath(layout, `${identity}.key`),
});

export function poolDatabaseDocument(poolUrl: string) {
  return { databaseUrl: poolUrl };
}

export function wrapsDocument(wraps: ReadonlyArray<{ installationId: string; wrapVersion: number; masterKeyId: string; wrappedDataKey: Uint8Array }>) {
  return {
    schemaVersion: "factory.key-wraps.v1", installationId: INSTALLATION,
    wraps: wraps.map((wrap) => ({ installationId: wrap.installationId, wrapVersion: wrap.wrapVersion, masterKeyId: wrap.masterKeyId, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") })),
  };
}

export function poolDocument(layout: StackLayout) {
  return {
    schemaVersion: "factory.pool-process.v1", installationId: INSTALLATION, poolId: POOL_ID,
    hostname: "127.0.0.1", port: layout.ports.pool,
    database: { credentialsPath: secretPath(layout, "pool-database.json"), expectedDatabase: layout.poolDatabase, expectedRole: decodeURIComponent(new URL(layout.poolUrl).username) },
    tls: { privateKeyPath: secretPath(layout, "server.key"), certificatePath: secretPath(layout, "server.pem"), caPath: secretPath(layout, "ca.pem") },
    tokens: { issuer: "factory-proof", audience: "factory-pool", publicKeyPaths: { proof: secretPath(layout, "pool-token.pem") } },
    identities: {
      tenants: { "tenant-a": { tenantId: TENANT, tokenSubject: TENANT } },
      supervisors: { [SUPERVISOR_SUBJECT]: { supervisorId: SUPERVISOR_SUBJECT, tokenSubject: SUPERVISOR_SUBJECT, hostIds: [HOST_ID] } },
    },
    resources: { capacities: { cpu: 4 }, gpuHosts: [], hosts: [HOST_ID] },
    readinessFilePath: readinessPath(layout, "pool.json"), readinessHeartbeatMs: 2_000,
  };
}

export function supervisorDocument(layout: StackLayout) {
  const supervisorTls = tls(layout, "supervisor");
  return {
    schemaVersion: "factory.supervisor-process.v1", installationId: INSTALLATION, hostId: HOST_ID,
    hostKeyPath: secretPath(layout, "host.key"), hostKeyId: "host-key-1",
    runnerRoot: runnerRoot(layout), readinessFilePath: readinessPath(layout, "supervisor.json"), readinessHeartbeatMs: 2_000,
    services: {
      hostname: "127.0.0.1", port: layout.ports.hostService, peerTenants: { "tenant-a": TENANT }, hostKeyIdPath: secretPath(layout, "host.kid"),
      tls: tls(layout, "server"),
      pool: { baseUrl: `https://127.0.0.1:${layout.ports.pool}`, serviceTokenPath: secretPath(layout, "supervisor.token"), tls: supervisorTls },
      // One route per tenant; this stack runs one tenant.
      guestBrokers: { [TENANT]: { baseUrl: `https://127.0.0.1:${layout.ports.guestBroker}`, serviceTokenPath: secretPath(layout, "guest-broker-host.token"), tls: supervisorTls } },
    },
  };
}

export function startupDocument(layout: StackLayout) {
  const clientTls = tls(layout, "client");
  const serverTls = tls(layout, "server");
  return {
    schemaVersion: "factory.startup.v1",
    installationId: INSTALLATION, tenantId: TENANT, poolId: POOL_ID, hostId: HOST_ID,
    temporalNamespace: NAMESPACE,
    orphanSweepIntervalMs: 30_000,
    orchestrationReadinessFilePath: readinessPath(layout, "orchestration.json"),
    poolReadinessFilePath: readinessPath(layout, "pool.json"),
    supervisorReadinessFilePath: readinessPath(layout, "supervisor.json"),
    readinessHeartbeatMs: 5_000,
    readinessRetry: { delayMs: 2_000, windowMs: 240_000 },
    gateway: { hostname: "127.0.0.1", port: layout.ports.gateway, tls: clientTls },
    privateService: {
      hostname: "127.0.0.1", port: layout.ports.privateService, certificateIdentity: "tenant-a", tls: serverTls,
      tokens: { issuer: "factory-proof", audience: "factory-pool", publicKeyPaths: { proof: secretPath(layout, "pool-token.pem") } },
    },
    temporalHttp: { endpoint: `http://127.0.0.1:${layout.ports.temporalHttp}` },
    pool: { baseUrl: `https://127.0.0.1:${layout.ports.pool}`, serviceTokenPath: secretPath(layout, "tenant.token"), tls: clientTls },
    hostLaunch: {
      baseUrl: `https://127.0.0.1:${layout.ports.hostService}`, serverName: "localhost",
      attemptTokenSecretPath: secretPath(layout, "attempt-token"),
      tls: { ...clientTls, serviceTokenPath: secretPath(layout, "tenant.token") },
    },
    hostStopKeys: [{ hostId: HOST_ID, hostKeyId: "host-key-1", publicKeyPath: secretPath(layout, "host.pub") }],
    guestBroker: {
      hostname: "127.0.0.1", port: layout.ports.guestBroker, hosts: { [SUPERVISOR_SUBJECT]: HOST_ID }, tls: serverTls,
      tokens: { issuer: GUEST_BROKER_ISSUER, audience: FACTORY_GUEST_BROKER_AUDIENCE, publicKeyPaths: { w19a: secretPath(layout, "guest-broker-host-token.pem") } },
    },
    runnerProfiles: layout.runnerProfiles,
    ...(layout.modelProvider === undefined ? {} : { modelProvider: layout.modelProvider }),
    storage: {
      ordinary: { endpoint: "http://127.0.0.1:18333", bucket: TENANT, prefix: "ordinary", credentialSet: "ordinary", credentialsPath: secretPath(layout, "ordinary-storage.json") },
      archive: { endpoint: "http://127.0.0.1:18334", bucket: TENANT, prefix: "archive", credentialSet: "archive", credentialsPath: secretPath(layout, "archive-storage.json") },
    },
    keys: { masterKeyFilePath: secretPath(layout, "master.key"), masterKeyId: MASTER_KEY_ID, wrappedKeyFilePath: secretPath(layout, "wraps.json"), grantableRoots: [join(layout.root, "project")] },
    workers: { idleDelayMs: 200, batch: 4 },
  };
}

export function orchestratorDocument(layout: StackLayout) {
  const clientTls = tls(layout, "client");
  return {
    schemaVersion: "factory.orchestrator-process.v1", installationId: INSTALLATION, tenantId: TENANT,
    temporal: { address: `127.0.0.1:${layout.ports.temporalTls}`, namespace: NAMESPACE, serverName: "localhost", ...clientTls, apiKeyPath: secretPath(layout, "temporal-api.key") },
    gateway: { baseUrl: `https://127.0.0.1:${layout.ports.privateService}`, serverName: "localhost", tls: { ...clientTls, serviceTokenPath: secretPath(layout, "orchestrator.token") } },
    codec: { wrappedKeyFilePath: secretPath(layout, "wraps.json"), masterKeyFilePath: secretPath(layout, "master.key"), masterKeyId: MASTER_KEY_ID, grantableRoots: [join(layout.root, "project")] },
    readinessFilePath: readinessPath(layout, "orchestration.json"), readinessHeartbeatMs: 5_000,
  };
}
