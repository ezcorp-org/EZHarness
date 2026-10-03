import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CANDIDATE_SANDBOX_QUALIFICATION_CASES,
  sandboxPresetDigest,
  type CandidateVerificationReport,
  type InvocationContext,
  type ReverseRpc,
  type Runner,
} from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { IncusSandboxAdapter } from "../../extensions/incus-sandbox/adapter";
import { parseIncusConnectionConfig } from "../../extensions/incus-sandbox/config";
import { createHostIncusTransport } from "../../extensions/incus-sandbox/host-transport";
import type { IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { ReleaseProcess } from "../extensions/release-process";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import { digestObject } from "../extensions/v4/blobs";
import { sandboxPresetQualificationReleaseDigest } from "../extensions/v4/sandbox-preset-qualification";
import { ProviderRpcBroker, type ProviderConnectionResolver } from "./provider-rpc-broker";
import { HostIncusProbeTransport } from "./incus-transport/transport";

const certificate = readFileSync(new URL("./incus-transport/test-server.pem", import.meta.url), "utf8");
const fingerprint = createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
const secret = "provider-private-key-canary";

type ProbeFetch = NonNullable<ConstructorParameters<typeof HostIncusProbeTransport>[2]>;

async function fixture(options: { fetch?: ProbeFetch } = {}) {
  const runtime = releaseRuntimeFixture("incus-installation", incusManifest);
  const snapshot = runtime.snapshot;
  const release = snapshot.release;
  const qualificationDigest = sandboxPresetQualificationReleaseDigest({
    ...release,
    releaseDigest: digestObject(Object.fromEntries(Object.entries(release).filter(([key]) => key !== "id" && key !== "createdAt" && key !== "releaseDigest"))),
  });
  const verification: CandidateVerificationReport = {
    catalog: "verified", smoke: "not_declared", capabilities: [],
    sandboxPresetQualifications: await Promise.all(incusManifest.sandboxProviders![0]!.presets.map(async preset => ({
      producer: "host" as const, providerId: "incus", presetId: preset.id, profile: preset.profile,
      releaseDigest: qualificationDigest, presetDigest: await sandboxPresetDigest(preset),
      verifiedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
      cases: CANDIDATE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: "passed" as const })),
    }))),
  };
  release.verification = verification;
  release.releaseDigest = digestObject(Object.fromEntries(Object.entries(release).filter(([key]) => key !== "id" && key !== "createdAt" && key !== "releaseDigest")));
  let revision = 1;
  let revoked = false;
  let providerReleaseId = release.id;
  let generation = snapshot.installation.generation;
  let transportCalls = 0;
  const connection = {
    id: "incus-connection", revision, providerInstallationId: snapshot.installation.id,
    providerReleaseId, endpoint: "https://incus.example:8443", serverCertificatePem: certificate,
    project: "sandbox", configuration: { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: "client-cert", privateKeyPem: secret, revokedAt: null,
  };
  const connections: ProviderConnectionResolver = {
    getMetadata: async id => id === connection.id ? { id, revision, providerInstallationId: connection.providerInstallationId, providerReleaseId, revokedAt: revoked ? new Date() : null } : null,
    resolveForHost: async scope => {
      if (revoked || scope.connectionId !== connection.id || scope.revision !== revision
        || scope.providerReleaseId !== providerReleaseId || scope.providerInstallationId !== connection.providerInstallationId) {
        throw new Error(`connection denied: ${secret}`);
      }
      return { ...connection, revision, providerReleaseId };
    },
  };
  const defaultFetch: ProbeFetch = async url => {
    transportCalls++;
    const path = new URL(url).pathname;
    const metadata = path === "/1.0" ? { api_version: "1.0", environment: { kernel_architecture: "x86_64", server_version: "6.0.6" } }
      : path.startsWith("/1.0/projects/") ? { name: "sandbox", config: { restricted: "true" } }
      : { name: "ezharness", config: {} };
    return Response.json({ type: "sync", status_code: 200, metadata });
  };
  const broker = new ProviderRpcBroker(connections, (scope, signal) => new HostIncusProbeTransport(connections, {
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revision: scope.revision, signal,
  }, options.fetch ?? defaultFetch));
  let onDispatch: ((context: InvocationContext, rpc: ReverseRpc) => Promise<unknown>) | undefined;
  const runner: Runner = {
    build: async () => { throw new Error("unused"); }, cancel: async () => {},
    inspect: async id => ({ id, state: "running", diagnostics: [] }), collectArtifacts: async () => ({}),
    start: async (start, rpc) => ({ workerId: start.workerId, close: async () => {}, onNotification: () => () => {},
      request: async (method, params) => {
        if (method === "extension/discover") return snapshot.release.manifest;
        if (!onDispatch) throw new Error("No dispatch configured");
        return onDispatch((params as { context: InvocationContext }).context, rpc);
      },
    }),
  };
  const process = new ReleaseProcess(snapshot.installation.id, {
    runner: async () => runner, resolve: async () => ({ ...snapshot, installation: { ...snapshot.installation, generation, acknowledgedGeneration: generation } }),
    providerRpcBroker: broker,
  });
  const input = { providerId: "incus", connectionId: connection.id, profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
    presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) };
  return {
    process, input, snapshot, broker, get transportCalls() { return transportCalls; },
    setDispatch(callback: typeof onDispatch) { onDispatch = callback; },
    revoke() { revoked = true; revision++; },
    changeRelease() { providerReleaseId = "another-release"; },
    changeGeneration() { generation++; },
  };
}

test("host-owned Incus preflight reaches reserved RPC and fails closed after a bounded real probe", async () => {
  const value = await fixture();
  value.setDispatch(async (context, rpc) => {
    const config = parseIncusConnectionConfig(context.metadata?.providerConfig);
    const transport = createHostIncusTransport({ call: (method, input) => rpc(method, { context, input }) });
    return new IncusSandboxAdapter(config, transport).invoke("preflight", value.input);
  });
  try {
    const failure = await value.process.callIncusProbe(value.input, value.input.connectionId).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    expect(value.transportCalls).toBe(3);
    expect(JSON.stringify(failure)).not.toContain(secret);
  } finally { value.process.kill(); }
});

test("preview endpoint commands stay closed before a scoped host relay exists", async () => {
  const value = await fixture();
  try {
    const scope = {
      providerId: "incus", connectionId: value.input.connectionId,
      sandboxId: "sandbox-1", rpcDeadlineMs: Date.now() + 5_000,
      requestId: "endpoint-open-1", idempotencyKey: "endpoint-open-1",
      port: 5173, protocol: "http", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(value.broker.prepareAction(value.snapshot, "sandbox-1", "endpoints.open", scope))
      .rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(value.broker.prepareAction(value.snapshot, "sandbox-1", "endpoints.close", {
      ...scope, endpointId: "endpoint-1",
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(value.transportCalls).toBe(0);
  } finally { value.process.kill(); }
});

test("ordinary calls and forged provider pins never reach the backend", async () => {
  const value = await fixture();
  const ordinary = registerCallProvenance({ actorExtensionId: value.snapshot.installation.id, onBehalfOf: "fixture-owner",
    conversationId: null, ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  let denial: unknown;
  value.setDispatch(async (context, rpc) => { denial = await rpc("ezcorp/provider.incus.transport", { context, input: { command: {
    action: "probe", connectionId: value.input.connectionId, deadlineMs: Date.now() + 5000,
    pins: { connectionId: value.input.connectionId, serverCertificateSha256: fingerprint, project: "sandbox", profile: "forged", helperVersion: "0.1.0", guestUser: "sandbox" },
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: value.input.connectionId }, payload: {},
  } satisfies IncusTransportRequest } }); return { observation: { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: false } }; });
  try {
    await expect(value.process.call("incus/preflight", { ...value.input, _meta: { ezCallId: ordinary } })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await value.process.callIncusProbe(value.input, value.input.connectionId);
    expect(denial).toMatchObject({ ok: false, error: { kind: "permission" } });
    expect(value.transportCalls).toBe(0);
  } finally { value.process.kill(); releaseCallProvenance(ordinary); }
});

test("revoked and wrong-release connections fail before worker dispatch", async () => {
  for (const change of ["revoke", "changeRelease"] as const) {
    const value = await fixture();
    value[change]();
    try {
      await expect(value.process.callIncusProbe(value.input, value.input.connectionId)).rejects.toMatchObject({ code: "INVALID_PROVIDER_CONFIG" });
      expect(value.transportCalls).toBe(0);
    } finally { value.process.kill(); }
  }
});

test("stale release generation and mutation are denied before backend I/O", async () => {
  const value = await fixture();
  value.setDispatch(async (context, rpc) => {
    value.changeGeneration();
    return rpc("ezcorp/provider.incus.transport", { context, input: { command: {
      action: "instance.create", connectionId: value.input.connectionId, deadlineMs: Date.now() + 5000,
      pins: parseIncusConnectionConfig(context.metadata?.providerConfig),
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: value.input.connectionId }, payload: {},
    } satisfies IncusTransportRequest } });
  });
  try {
    await expect(value.process.callIncusProbe(value.input, value.input.connectionId)).rejects.toMatchObject({ code: "RELEASE_CHANGED" });
    expect(value.transportCalls).toBe(0);
  } finally { value.process.kill(); }
});

test("mutation action is unsupported even with an active provider invocation", async () => {
  const value = await fixture();
  let denial: unknown;
  value.setDispatch(async (context, rpc) => {
    denial = await rpc("ezcorp/provider.incus.transport", { context, input: { command: {
      action: "instance.create", connectionId: value.input.connectionId, deadlineMs: Date.now() + 5000,
      pins: parseIncusConnectionConfig(context.metadata?.providerConfig),
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: value.input.connectionId }, payload: {},
    } satisfies IncusTransportRequest } });
    return { observation: { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: false } };
  });
  try {
    await value.process.callIncusProbe(value.input, value.input.connectionId);
    expect(denial).toMatchObject({ ok: false, error: { kind: "unsupported", effect: "none" } });
    expect(value.transportCalls).toBe(0);
  } finally { value.process.kill(); }
});

test("connection revision change during an invocation denies the next probe", async () => {
  const value = await fixture();
  let denial: unknown;
  value.setDispatch(async (context, rpc) => {
    value.revoke();
    denial = await rpc("ezcorp/provider.incus.transport", { context, input: { command: {
      action: "probe", connectionId: value.input.connectionId, deadlineMs: Date.now() + 5000,
      pins: parseIncusConnectionConfig(context.metadata?.providerConfig),
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: value.input.connectionId }, payload: { allocate: false },
    } satisfies IncusTransportRequest } });
    return { observation: { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: false } };
  });
  try {
    await value.process.callIncusProbe(value.input, value.input.connectionId);
    expect(denial).toMatchObject({ ok: false, error: { kind: "not_found", effect: "none" } });
    expect(value.transportCalls).toBe(0);
  } finally { value.process.kill(); }
});

test("cancelling a provider invocation aborts a stalled Incus GET", async () => {
  const entered = Promise.withResolvers<void>();
  let requests = 0;
  let aborted = false;
  const value = await fixture({ fetch: async (_url, init) => {
    requests++;
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (init.signal?.aborted) { aborted = true; resolve(); return; }
      init.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    throw new Error("cancelled fake request");
  } });
  value.setDispatch(async (context, rpc) => {
    const config = parseIncusConnectionConfig(context.metadata?.providerConfig);
    const transport = createHostIncusTransport({ call: (method, input) => rpc(method, { context, input }) });
    return new IncusSandboxAdapter(config, transport).invoke("preflight", value.input);
  });
  const controller = new AbortController();
  try {
    const pending = value.process.callIncusProbe(value.input, value.input.connectionId, { signal: controller.signal });
    void pending.catch(() => undefined);
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(aborted).toBe(true);
    expect(requests).toBe(1);
  } finally { value.process.kill(); }
});
