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
  process.exitCode = previousExitCode;
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
  process.exitCode = previousExitCode;
  assert.equal(second.length, 1);
  assert.match(String(second[0]?.[1]), /factory-configuration-invalid/);
});
