import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TemporalPayloadCodec } from "../../../../src/factory/encryption.ts";
import {
  loadFactoryTemporalCredentials,
  parseFactoryOrchestratorProcessConfig,
  runConfiguredFactoryOrchestrator,
  productionMainDependencies,
  runFactoryOrchestratorMain,
  startFactoryOrchestratorMain,
} from "../../../../src/factory/orchestration-process.ts";
import { readFactoryOrchestrationReadiness } from "../../../../src/factory/orchestration-readiness.ts";

const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
const codec: TemporalPayloadCodec = { encode: async (values) => values, decode: async (values) => values };

function config(directory: string) {
  return {
    schemaVersion: "factory.orchestrator-process.v1",
    installationId: "installation-1",
    tenantId: "tenant-1",
    temporal: {
      address: "temporal.internal:7233", namespace: "tenant-1", serverName: "temporal.internal",
      caPath: join(directory, "temporal-ca"), certificatePath: join(directory, "temporal-cert"),
      privateKeyPath: join(directory, "temporal-key"), apiKeyPath: join(directory, "temporal-token"),
      credentialRefreshMs: 1_000, pollingProbeTimeoutMs: 1_000,
    },
    gateway: {
      baseUrl: "https://factory.internal", serverName: "factory.internal", requestTimeoutMs: 1_000,
      tls: { caPath: "/refs/gateway-ca", certificatePath: "/refs/gateway-cert", privateKeyPath: "/refs/gateway-key", serviceTokenPath: "/refs/gateway-token" },
    },
    codec: { wrappedKeyFilePath: "/refs/wraps", masterKeyFilePath: "/refs/master", masterKeyId: "master-1", grantableRoots: ["/run/secrets"] },
    readinessFilePath: join(directory, "readiness.json"), readinessHeartbeatMs: 1_000, dispatchEmptyDelayMs: 10,
  } as const;
}

async function privateFile(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("the strict launcher config contains only bounded references", () => {
  const value = config("/run/user/1001/factory");
  assert.deepEqual(parseFactoryOrchestratorProcessConfig(value), value);
  assert.throws(() => parseFactoryOrchestratorProcessConfig({ ...value, apiKey: "secret" }), /config is invalid/);
  assert.throws(() => parseFactoryOrchestratorProcessConfig({ ...value, temporal: { ...value.temporal, namespace: "" } }), /config is invalid/);
  assert.throws(() => parseFactoryOrchestratorProcessConfig({ ...value, gateway: { ...value.gateway, tls: { ...value.gateway.tls, token: "secret" } } }), /config is invalid/);
  assert.throws(() => parseFactoryOrchestratorProcessConfig({ ...value, codec: { ...value.codec, grantableRoots: [] } }), /config is invalid/);
});

test("the Node launcher reloads private Temporal credentials and passes the encrypted codec to the process", async () => {
  const directory = await mkdtemp(join(runtimeRoot, "factory-process-config-"));
  await chmod(directory, 0o700);
  try {
    const value = config(directory);
    await Promise.all([
      privateFile(value.temporal.caPath, "ca"), privateFile(value.temporal.certificatePath, "certificate"),
      privateFile(value.temporal.privateKeyPath, "private-key"), privateFile(value.temporal.apiKeyPath, "token-1\n"),
    ]);
    const configPath = join(directory, "process.json");
    await privateFile(configPath, JSON.stringify(value));
    let receivedCodec: unknown;
    let receivedKeyConfig: unknown;
    await runConfiguredFactoryOrchestrator(configPath, new AbortController().signal, {
      loadCodec: async (keyConfig) => { receivedKeyConfig = keyConfig; return codec; },
      run: async (options) => {
        receivedCodec = options.payloadCodec;
        const first = await options.loadTemporalCredentials();
        assert.equal(first.apiKey, "token-1");
        await privateFile(value.temporal.apiKeyPath, "token-2");
        const second = await options.loadTemporalCredentials();
        assert.equal(second.apiKey, "token-2");
        assert.equal(second.tlsFingerprint, first.tlsFingerprint);
        await options.readiness.write({ lifecycle: "ready", workerPolling: true, dispatcherLive: true, credentialGeneration: 1 });
      },
    });
    assert.equal(receivedCodec, codec);
    assert.deepEqual(receivedKeyConfig, { installationId: "installation-1", tenantId: "tenant-1", ...value.codec });
    const ready = await readFactoryOrchestrationReadiness({
      installationId: value.installationId, tenantId: value.tenantId, namespace: value.temporal.namespace,
      taskQueue: "factory-orchestrator", readinessFilePath: value.readinessFilePath, readinessHeartbeatMs: 1_000,
    });
    assert.equal(ready.lifecycle, "ready");
    assert.equal(ready.credentialGeneration, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private credential reads reject an empty API key", async () => {
  const directory = await mkdtemp(join(runtimeRoot, "factory-process-empty-token-"));
  await chmod(directory, 0o700);
  try {
    const value = config(directory);
    await Promise.all([
      privateFile(value.temporal.caPath, "ca"), privateFile(value.temporal.certificatePath, "certificate"),
      privateFile(value.temporal.privateKeyPath, "private-key"), privateFile(value.temporal.apiKeyPath, "   "),
    ]);
    await assert.rejects(loadFactoryTemporalCredentials(value.temporal), /API key is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the process main removes signal handlers and reports only a bounded failure status", async () => {
  const listeners = new Map<string, () => void>();
  const removed: string[] = [];
  let failed = 0;
  const dependencies = {
    runConfigured: async (path: string, signal: AbortSignal) => {
      assert.equal(path, "/private/process.json");
      listeners.get("SIGTERM")?.();
      assert.equal(signal.aborted, true);
    },
    once: (event: "SIGINT" | "SIGTERM", listener: () => void) => { listeners.set(event, listener); },
    removeListener: (event: "SIGINT" | "SIGTERM") => { removed.push(event); },
    fail: () => { failed += 1; },
  };
  await runFactoryOrchestratorMain(["node", "launcher", "/private/process.json"], dependencies);
  assert.deepEqual(removed, ["SIGINT", "SIGTERM"]);
  await assert.rejects(runFactoryOrchestratorMain(["node", "launcher"], dependencies), /config path/);
  startFactoryOrchestratorMain(["node", fileURLToPath(new URL("../../../../src/factory/orchestration-process.ts", import.meta.url))], new URL("../../../../src/factory/orchestration-process.ts", import.meta.url).href, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed, 1);
});

test("the real entry prints the cause before it sets the exit code", () => {
  // A silent exit 1 is the one symptom a reader cannot act on, and this
  // default is what the process actually runs with. The order matters: the
  // lines are written first, so a reader still sees them if anything later in
  // the shutdown path throws.
  const printed: unknown[][] = [];
  const error = console.error;
  const previousExitCode = process.exitCode;
  console.error = (...parts: unknown[]) => { printed.push(parts); assert.equal(process.exitCode, previousExitCode); };
  try {
    productionMainDependencies.fail(Object.assign(new Error("configuration refused"), { stack: undefined, cause: new Error("missing temporal address") }));
  } finally {
    console.error = error;
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode ?? 0;
  assert.equal(printed.length, 2);
  assert.match(String(printed[0]?.[1]), /configuration refused/);
  assert.match(String(printed[1]?.[1]), /missing temporal address/);

  // A non-Error refusal, and one with no cause, still print exactly once.
  const second: unknown[][] = [];
  console.error = (...parts: unknown[]) => { second.push(parts); };
  try {
    productionMainDependencies.fail("factory-configuration-invalid");
  } finally {
    console.error = error;
  }
  process.exitCode = previousExitCode ?? 0;
  assert.equal(second.length, 1);
  assert.match(String(second[0]?.[1]), /factory-configuration-invalid/);
});

// W15b R1: the running orchestration process opens its data key through the
// key service the document selects. Each non-file kind runs against the same
// local key-service double the restore tests use, through the real launcher
// and the real codec loader, and a Temporal payload round-trips.
test("the launcher opens the payload codec through each selected key service, and a mismatch fails closed typed", async () => {
  const { startFactoryKeyServiceDouble } = await import("../../../../src/__tests__/helpers/factory-key-service-double.ts");
  const { MemoryWraps } = await import("../../../../src/__tests__/helpers/factory-kms-doubles.ts");
  const { InstallationDataKey } = await import("../../../../src/factory/encryption.ts");
  const { composeFactoryDataKeyWrapper } = await import("../../../../src/factory/key-management.ts");
  const { loadFactoryTemporalPayloadCodec } = await import("../../../../src/factory/file-key-wraps.ts");
  const { defaultPayloadConverter } = await import("@temporalio/common");
  const directory = await mkdtemp(join(runtimeRoot, "factory-process-kms-"));
  await chmod(directory, 0o700);
  const service = await startFactoryKeyServiceDouble({ transitToken: "transit-token" });
  try {
    const base = config(directory);
    await Promise.all([
      privateFile(base.temporal.caPath, "ca"), privateFile(base.temporal.certificatePath, "certificate"),
      privateFile(base.temporal.privateKeyPath, "private-key"), privateFile(base.temporal.apiKeyPath, "token"),
      privateFile(join(directory, "kms.json"), JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" })),
      privateFile(join(directory, "transit.token"), "transit-token"),
    ]);
    const kinds = {
      "cloud-kms": { kind: "cloud-kms", keyId: "arn:aws:kms:eu-west-1:111122223333:key/tenant-1", region: "eu-west-1", credentialsPath: join(directory, "kms.json"), endpoint: service.endpoint },
      transit: { kind: "transit", endpoint: service.endpoint, keyName: "factory-data-key", tokenPath: join(directory, "transit.token") },
    } as const;
    const wrapsFor = async (keyManagement: (typeof kinds)[keyof typeof kinds], file: string): Promise<string> => {
      const wraps = new MemoryWraps();
      await InstallationDataKey.loadOrCreate("installation-1", wraps, await composeFactoryDataKeyWrapper({ masterKeyFilePath: "/unused", masterKeyId: "unused", grantableRoots: [] }, keyManagement));
      const path = join(directory, file);
      await privateFile(path, JSON.stringify({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-1", wraps: wraps.rows.map((row) => ({ ...row, wrappedDataKey: Buffer.from(row.wrappedDataKey).toString("base64") })) }));
      return path;
    };
    const launch = async (codec: Record<string, unknown>): Promise<TemporalPayloadCodec> => {
      const configPath = join(directory, "process.json");
      await privateFile(configPath, JSON.stringify({ ...base, codec }));
      let payloadCodec: TemporalPayloadCodec | undefined;
      await runConfiguredFactoryOrchestrator(configPath, new AbortController().signal, {
        loadCodec: loadFactoryTemporalPayloadCodec,
        run: async (options) => { payloadCodec = options.payloadCodec; },
      });
      return payloadCodec!;
    };
    const wrapped: Record<string, string> = {};
    for (const [kind, keyManagement] of Object.entries(kinds)) {
      wrapped[kind] = await wrapsFor(keyManagement, `${kind}-wraps.json`);
      const before = service.calls.length;
      const codec = await launch({ ...base.codec, wrappedKeyFilePath: wrapped[kind], keyManagement });
      // The launcher reached the selected service to open the key, and only it.
      assert.ok(service.calls.slice(before).length > 0);
      assert.ok(service.calls.slice(before).every((call) => call.startsWith(kind === "transit" ? "transit:decrypt:" : "kms:decrypt:")));
      const context = { type: "workflow" as const, namespace: "tenant-1", workflowId: "tenant-1/run-a" };
      const payload = defaultPayloadConverter.toPayload({ command: "resume", kind }, context);
      const encoded = await codec.encode([payload], context);
      assert.notDeepEqual(encoded[0]!.data, payload.data);
      assert.deepEqual(defaultPayloadConverter.fromPayload((await codec.decode(encoded, context))[0]!, context), { command: "resume", kind });
    }
    // Mismatches refuse with the typed error: wraps made under the cloud KMS opened with transit, and the reverse.
    await assert.rejects(launch({ ...base.codec, wrappedKeyFilePath: wrapped["cloud-kms"], keyManagement: kinds.transit }), { name: "FactoryEncryptionError", code: "factory_key_invalid" });
    await assert.rejects(launch({ ...base.codec, wrappedKeyFilePath: wrapped.transit, keyManagement: kinds["cloud-kms"] }), { name: "FactoryEncryptionError", code: "factory_key_invalid" });
    // The right key id at a service that never wrapped it: the service refuses, typed.
    const other = await startFactoryKeyServiceDouble({ transitToken: "transit-token" });
    try {
      await assert.rejects(launch({ ...base.codec, wrappedKeyFilePath: wrapped.transit, keyManagement: { ...kinds.transit, endpoint: other.endpoint } }), { name: "FactoryEncryptionError", code: "factory_key_missing" });
    } finally { await other.stop(); }
    // A malformed selection is refused by the strict config parser before any key is read.
    await assert.rejects(launch({ ...base.codec, keyManagement: { kind: "hsm" } }), /config is invalid/);
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
