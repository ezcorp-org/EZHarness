import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../__tests__/helpers/factory-private-root";
import {
  FACTORY_GATEWAY_PROCESS_SCHEMA,
  factoryGatewayProductionDependencies,
  parseFactoryGatewayProcessConfig,
  runFactoryGatewayProcess,
  startFactoryGatewayMain,
  type FactoryGatewayProcessConfig,
  type FactoryGatewayProcessDependencies,
} from "./gateway-process";

const CONFIG: FactoryGatewayProcessConfig = {
  schemaVersion: FACTORY_GATEWAY_PROCESS_SCHEMA,
  installationId: "inst-tenant-01",
  tenantId: "tenant-01",
  hostname: "0.0.0.0",
  port: 40_012,
  tls: { caPath: "/run/ezcorp/secrets/mesh-ca.crt", certificatePath: "/run/ezcorp/secrets/mesh-server.crt", privateKeyPath: "/run/ezcorp/secrets/mesh-server.key" },
  attemptTokenSecretPath: "/run/ezcorp/secrets/attempt-token-secret",
  databaseUrlPath: "/run/ezcorp/secrets/gateway-database-url",
  interpreterCompatibility: "factory-interpreter-1",
};

function refused(value: unknown): string | undefined {
  try { parseFactoryGatewayProcessConfig(value); } catch (error) { return (error as Error).message; }
  return undefined;
}

describe("parseFactoryGatewayProcessConfig", () => {
  test("accepts the document the deployment renders, as a detached copy", () => {
    const parsed = parseFactoryGatewayProcessConfig(CONFIG);
    expect(parsed).toEqual(CONFIG);
    expect(parsed).not.toBe(CONFIG);
    expect(parsed.tls).not.toBe(CONFIG.tls);
  });

  test("accepts boundary values: port 1 and 65535, a 256-character identity, an IPv6 or DNS hostname", () => {
    for (const valid of [{ port: 1 }, { port: 65_535 }, { installationId: `a${"b".repeat(255)}` }, { hostname: "::1" }, { hostname: "gateway.tenant-01.internal" }]) {
      expect(refused({ ...CONFIG, ...valid })).toBeUndefined();
    }
  });

  test("refuses a document that is not an object, or has a missing or extra field", () => {
    const { databaseUrlPath: _missing, ...withoutField } = CONFIG;
    for (const value of [null, undefined, "config", 7, [], {}, withoutField, { ...CONFIG, extra: 1 }]) {
      expect(refused(value)).toBe("factory gateway config is invalid");
    }
  });

  test("refuses every malformed field", () => {
    const cases: Record<string, unknown>[] = [
      { schemaVersion: "factory.gateway-process.v2" },
      { installationId: "" }, { installationId: "-leading" }, { installationId: "has space" }, { installationId: `a${"b".repeat(256)}` }, { installationId: 7 },
      { tenantId: "tenant/01" }, { tenantId: null },
      { interpreterCompatibility: "" }, { interpreterCompatibility: "a b" }, { interpreterCompatibility: 1 },
      { hostname: 127001 }, { hostname: "" }, { hostname: "bad host" }, { hostname: "a".repeat(254) },
      { port: 0 }, { port: 65_536 }, { port: 1.5 }, { port: "40012" },
      { tls: undefined }, { tls: null }, { tls: { ...CONFIG.tls, extra: "/x" } }, { tls: { caPath: CONFIG.tls.caPath, certificatePath: CONFIG.tls.certificatePath } },
      { tls: { ...CONFIG.tls, caPath: "relative/ca.crt" } }, { tls: { ...CONFIG.tls, certificatePath: "/run/../run/cert" } }, { tls: { ...CONFIG.tls, privateKeyPath: "" } },
      { attemptTokenSecretPath: "secret" }, { attemptTokenSecretPath: `/${"a".repeat(4_096)}` }, { databaseUrlPath: "/run/ezcorp/secrets/" }, { databaseUrlPath: 1 },
    ];
    for (const field of cases) expect(refused({ ...CONFIG, ...field })).toBe("factory gateway config is invalid");
  });
});

interface Recorder { reads: string[]; starts: { config: FactoryGatewayProcessConfig; material: unknown }[]; stops: number; closes: number; waited: AbortSignal[] }

function fakeDependencies(files: Record<string, string>, options: { onWait?: (signal: AbortSignal) => void; failStart?: Error } = {}): FactoryGatewayProcessDependencies & { recorder: Recorder } {
  const recorder: Recorder = { reads: [], starts: [], stops: 0, closes: 0, waited: [] };
  return {
    recorder,
    readText: async (path) => {
      recorder.reads.push(path);
      if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return files[path]!;
    },
    start: async (config, material) => {
      if (options.failStart) throw options.failStart;
      recorder.starts.push({ config, material });
      return { url: "https://127.0.0.1:40012", stop: () => { recorder.stops++; }, close: async () => { recorder.closes++; } };
    },
    wait: (signal) => new Promise<void>((settle) => {
      recorder.waited.push(signal);
      signal.addEventListener("abort", () => settle(), { once: true });
      options.onWait?.(signal);
    }),
  };
}

const FILES: Record<string, string> = {
  "/etc/gateway.json": JSON.stringify(CONFIG),
  [CONFIG.databaseUrlPath]: "postgres://role:pw@127.0.0.1:5432/product\n",
  [CONFIG.attemptTokenSecretPath]: "  attempt-secret\n",
  [CONFIG.tls.privateKeyPath]: "KEY\n",
  [CONFIG.tls.certificatePath]: "CERT\n",
  [CONFIG.tls.caPath]: "CA\n",
};

describe("runFactoryGatewayProcess", () => {
  test("reads its config and material, starts once, waits for the signal, then stops and closes once", async () => {
    const controller = new AbortController();
    let stopsDuringWait = -1;
    const dependencies = fakeDependencies(FILES, { onWait: () => { stopsDuringWait = dependencies.recorder.stops; controller.abort(); } });
    await runFactoryGatewayProcess("/etc/gateway.json", controller.signal, dependencies);
    const { recorder } = dependencies;
    expect(recorder.reads[0]).toBe("/etc/gateway.json");
    expect(recorder.reads.slice(1).sort()).toEqual([CONFIG.attemptTokenSecretPath, CONFIG.databaseUrlPath, CONFIG.tls.caPath, CONFIG.tls.certificatePath, CONFIG.tls.privateKeyPath].sort());
    expect(recorder.starts).toEqual([{ config: CONFIG, material: { databaseUrl: "postgres://role:pw@127.0.0.1:5432/product", attemptTokenSecret: "attempt-secret", tls: { key: "KEY\n", cert: "CERT\n", ca: "CA\n" } } }]);
    expect(recorder.waited).toEqual([controller.signal]);
    expect(stopsDuringWait).toBe(0);
    expect([recorder.stops, recorder.closes]).toEqual([1, 1]);
  });

  test("the listener is stopped and closed even when waiting fails", async () => {
    const dependencies = fakeDependencies(FILES);
    const failing = { ...dependencies, wait: async () => { throw new Error("wait failed"); } };
    expect((await factoryRejection(runFactoryGatewayProcess("/etc/gateway.json", new AbortController().signal, failing))).message).toBe("wait failed");
    expect([dependencies.recorder.stops, dependencies.recorder.closes]).toEqual([1, 1]);
  });

  test("an invalid config starts nothing", async () => {
    const dependencies = fakeDependencies({ ...FILES, "/etc/gateway.json": JSON.stringify({ ...CONFIG, port: 0 }) });
    expect((await factoryRejection(runFactoryGatewayProcess("/etc/gateway.json", new AbortController().signal, dependencies))).message).toBe("factory gateway config is invalid");
    expect(dependencies.recorder.starts).toEqual([]);
    expect(dependencies.recorder.reads).toEqual(["/etc/gateway.json"]);
  });

  test("a missing secret file starts nothing", async () => {
    const { [CONFIG.attemptTokenSecretPath]: _missing, ...files } = FILES;
    const dependencies = fakeDependencies(files);
    expect((await factoryRejection(runFactoryGatewayProcess("/etc/gateway.json", new AbortController().signal, dependencies))).code).toBe("ENOENT");
    expect(dependencies.recorder.starts).toEqual([]);
    expect(dependencies.recorder.stops).toBe(0);
  });

  test("a start failure is reported and nothing is stopped", async () => {
    const dependencies = fakeDependencies(FILES, { failStart: new Error("database unreachable") });
    expect((await factoryRejection(runFactoryGatewayProcess("/etc/gateway.json", new AbortController().signal, dependencies))).message).toBe("database unreachable");
    expect(dependencies.recorder.stops).toBe(0);
  });
});

describe("factoryGatewayProductionDependencies (without a database)", () => {
  let root: string;
  beforeAll(async () => { root = await makeFactoryPrivateRoot(); });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("readText reads a private file through the private reader", async () => {
    const path = await writeModeFile(join(root, "gateway-database-url"), "postgres://x\n");
    expect(await factoryGatewayProductionDependencies.readText(path)).toBe("postgres://x\n");
  });

  test("readText refuses a file others can read", async () => {
    const path = await writeModeFile(join(root, "leaky"), "secret\n", 0o644);
    expect((await factoryRejection(factoryGatewayProductionDependencies.readText(path))).message).toContain("private");
  });

  test("readText refuses bytes that are not UTF-8", async () => {
    const path = await writeModeFile(join(root, "binary"), new Uint8Array([0xff, 0xfe, 0x00]));
    expect(await factoryRejection(factoryGatewayProductionDependencies.readText(path))).toBeInstanceOf(TypeError);
  });

  test("wait settles when the signal aborts, and at once when it already has", async () => {
    const already = new AbortController();
    already.abort();
    await factoryGatewayProductionDependencies.wait(already.signal);
    const later = new AbortController();
    let settled = false;
    const waiting = factoryGatewayProductionDependencies.wait(later.signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    later.abort();
    await waiting;
    expect(settled).toBe(true);
  });
});

describe("startFactoryGatewayMain", () => {
  const MODULE = pathToFileURL("/srv/release/src/factory/gateway-process.ts").href;
  const signalListeners = () => ({ term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") });

  test("does nothing when the process was not started as this module", async () => {
    const dependencies = fakeDependencies(FILES);
    const failures: unknown[] = [];
    for (const argv of [["bun"], ["bun", "/srv/release/src/other.ts", "/etc/gateway.json"], ["bun", "", "/etc/gateway.json"]]) {
      await startFactoryGatewayMain(argv, MODULE, dependencies, (error) => failures.push(error));
    }
    expect(dependencies.recorder.reads).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a missing or extra argument is reported through fail, and the signal handlers are removed", async () => {
    const before = signalListeners();
    for (const argv of [["bun", "/srv/release/src/factory/gateway-process.ts"], ["bun", "/srv/release/src/factory/gateway-process.ts", "/etc/gateway.json", "extra"]]) {
      const dependencies = fakeDependencies(FILES);
      const failures: unknown[] = [];
      await startFactoryGatewayMain(argv, MODULE, dependencies, (error) => failures.push(error));
      expect(failures.map((error) => (error as Error).message)).toEqual(["factory gateway config path is required"]);
      expect(dependencies.recorder.reads).toEqual([]);
    }
    expect(signalListeners()).toEqual(before);
  });

  test("runs the gateway until SIGTERM, then stops it and removes its handlers", async () => {
    const before = signalListeners();
    const failures: unknown[] = [];
    const dependencies = fakeDependencies(FILES, {
      onWait: () => {
        // The handler main installed is the only one added since it started.
        const added = process.listeners("SIGTERM").at(-1) as () => void;
        expect(signalListeners()).toEqual({ term: before.term + 1, int: before.int + 1 });
        added();
      },
    });
    await startFactoryGatewayMain(["bun", "/srv/release/src/factory/gateway-process.ts", "/etc/gateway.json"], MODULE, dependencies, (error) => failures.push(error));
    expect(failures).toEqual([]);
    expect(dependencies.recorder.starts.length).toBe(1);
    expect(dependencies.recorder.waited[0]!.aborted).toBe(true);
    expect([dependencies.recorder.stops, dependencies.recorder.closes]).toEqual([1, 1]);
    expect(signalListeners()).toEqual(before);
  });

  test("a run failure goes to fail", async () => {
    const failures: unknown[] = [];
    await startFactoryGatewayMain(["bun", "/srv/release/src/factory/gateway-process.ts", "/etc/missing.json"], MODULE, fakeDependencies(FILES), (error) => failures.push(error));
    expect((failures[0] as { code?: string }).code).toBe("ENOENT");
  });

  test("the default failure report logs the message and sets a failing exit code", async () => {
    const previous = process.exitCode;
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      await startFactoryGatewayMain(["bun", "/srv/release/src/factory/gateway-process.ts"], MODULE, fakeDependencies(FILES));
      expect(logged).toEqual(["[gateway] factory gateway config path is required"]);
      expect(process.exitCode).toBe(1);
      logged.length = 0;
      await startFactoryGatewayMain(["bun", "/srv/release/src/factory/gateway-process.ts", "/etc/gateway.json"], MODULE, { ...fakeDependencies(FILES), readText: async () => { throw "not an error"; } });
      expect(logged).toEqual(["[gateway] not an error"]);
    } finally {
      console.error = originalError;
      process.exitCode = previous ?? 0;
    }
  });
});
