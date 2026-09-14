import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFactoryServiceReadiness, factorySupervisorReadinessOptions, FactoryServiceReadinessError } from "../service-readiness";
import {
  loadFactoryHostKey,
  parseFactorySupervisorProcessConfig,
  probeFactoryHostRunner,
  runConfiguredFactorySupervisor,
  runFactorySupervisorMain,
  startFactorySupervisorMain,
  factorySupervisorProductionDependencies,
  type FactorySupervisorProcessConfig,
  type FactorySupervisorProcessDependencies,
} from "./supervisor-process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-supervisor-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function config(root: string, overrides: Partial<FactorySupervisorProcessConfig> = {}): Record<string, unknown> {
  return {
    schemaVersion: "factory.supervisor-process.v1",
    installationId: "installation-01",
    hostId: "host-01",
    hostKeyPath: join(root, "host.key"),
    hostKeyId: "host-key-1",
    runnerRoot: join(root, "runner"),
    readinessFilePath: join(root, "supervisor.json"),
    readinessHeartbeatMs: 1_000,
    ...overrides,
  };
}

async function writeConfig(root: string, overrides: Partial<FactorySupervisorProcessConfig> = {}): Promise<string> {
  const path = join(root, "supervisor-config.json");
  await writeFile(path, JSON.stringify(config(root, overrides)), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function writeHostKey(root: string): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(root, "host.key");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(path, 0o600);
}

let abortController: AbortController | undefined;

/**
 * Drives the loop one pass at a time with no real timer: the injected wait
 * aborts the run, so every test observes exactly one observation cycle.
 */
function dependencies(overrides: Partial<FactorySupervisorProcessDependencies> = {}): FactorySupervisorProcessDependencies {
  return {
    loadHostKey: loadFactoryHostKey,
    probeRunner: async () => {},
    createReadiness: factorySupervisorProductionDependencies.createReadiness,
    wait: async () => { abortController?.abort(); },
    ...overrides,
  };
}

describe("parseFactorySupervisorProcessConfig", () => {
  test("accepts a complete document and refuses every incomplete one", async () => {
    const root = await privateRoot();
    expect(parseFactorySupervisorProcessConfig(config(root)).hostId).toBe("host-01");
    expect(parseFactorySupervisorProcessConfig({ ...config(root), readinessHeartbeatMs: undefined as never })).toBeDefined();

    for (const bad of [
      null, "text", [],
      { ...config(root), schemaVersion: "factory.supervisor-process.v2" },
      { ...config(root), installationId: "" },
      { ...config(root), hostId: "with\0null" },
      { ...config(root), hostKeyPath: "" },
      { ...config(root), hostKeyId: "" },
      { ...config(root), runnerRoot: "" },
      { ...config(root), readinessFilePath: "" },
      { ...config(root), readinessHeartbeatMs: 999 },
      { ...config(root), surprise: 1 },
    ]) {
      expect(() => parseFactorySupervisorProcessConfig(bad)).toThrow("factory supervisor config is invalid");
    }
    const missing = { ...config(root) } as Record<string, unknown>;
    delete missing.hostKeyId;
    expect(() => parseFactorySupervisorProcessConfig(missing)).toThrow("factory supervisor config is invalid");
  });
});

describe("loadFactoryHostKey", () => {
  test("proves the key loads and refuses bytes that are not a key", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    await expect(loadFactoryHostKey(join(root, "host.key"))).resolves.toBeUndefined();

    const wrong = join(root, "not-a-key");
    await writeFile(wrong, "not a key", { mode: 0o600 });
    await chmod(wrong, 0o600);
    await expect(loadFactoryHostKey(wrong)).rejects.toBeDefined();
    await expect(loadFactoryHostKey(join(root, "absent.key"))).rejects.toBeDefined();
  });
});

describe("runConfiguredFactorySupervisor", () => {
  test("publishes ready only after both facts are observed, then stopped on abort", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const scope = factorySupervisorReadinessOptions({ installationId: "installation-01", hostId: "host-01", readinessFilePath: join(root, "supervisor.json"), readinessHeartbeatMs: 1_000 });

    let probed = 0;
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({ probeRunner: async () => { probed += 1; } }));
    expect(probed).toBe(1);
    // The loop's last act records why it stopped, so a reader cannot mistake a
    // stopped supervisor for a live one whose record simply went stale.
    await expect(readFactoryServiceReadiness(scope)).rejects.toBeInstanceOf(FactoryServiceReadinessError);
    const stopped = JSON.parse(await Bun.file(join(root, "supervisor.json")).text());
    expect(stopped).toMatchObject({ lifecycle: "stopped", facts: { hostKeyReady: false, runnerReady: false } });
  });

  test("a reader accepts the record while the supervisor is mid-loop", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const scope = factorySupervisorReadinessOptions({ installationId: "installation-01", hostId: "host-01", readinessFilePath: join(root, "supervisor.json"), readinessHeartbeatMs: 1_000 });

    let observed: unknown;
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      probeRunner: async () => {},
      wait: async (_milliseconds, _signal) => {
        observed = await readFactoryServiceReadiness(scope);
        abortController!.abort();
      },
    }));
    expect(observed).toMatchObject({ service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true } });
  });

  test("names which fact failed rather than simply not publishing", async () => {
    const root = await privateRoot();
    const path = await writeConfig(root);
    abortController = new AbortController();

    // No host key on disk: the first fact fails.
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({ probeRunner: async () => {} }));
    let published: Record<string, unknown> = { lifecycle: "stopped" };
    abortController = new AbortController();
    await writeHostKey(root);
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      probeRunner: async () => { throw new Error("podman is not answering"); },
      wait: async () => {
        published = JSON.parse(await Bun.file(join(root, "supervisor.json")).text());
        abortController!.abort();
      },
    }));
    expect(published).toMatchObject({ lifecycle: "degraded", errorCode: "runner_unavailable", facts: { hostKeyReady: true, runnerReady: false } });
  });

  test("records host_key_unavailable when the key is the failing fact", async () => {
    const root = await privateRoot();
    const path = await writeConfig(root);
    abortController = new AbortController();
    let published: Record<string, unknown> = {};
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      loadHostKey: async () => { throw new Error("no key"); },
      wait: async () => {
        published = JSON.parse(await Bun.file(join(root, "supervisor.json")).text());
        abortController!.abort();
      },
    }));
    expect(published).toMatchObject({ lifecycle: "degraded", errorCode: "host_key_unavailable", facts: { hostKeyReady: false, runnerReady: false } });
  });

  test("takes no step at all when the signal has already aborted", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    const controller = new AbortController();
    controller.abort();
    let probed = 0;
    await runConfiguredFactorySupervisor(path, controller.signal, dependencies({ probeRunner: async () => { probed += 1; } }));
    expect(probed).toBe(0);
    expect(JSON.parse(await Bun.file(join(root, "supervisor.json")).text())).toMatchObject({ lifecycle: "stopped" });
  });

  test("refuses a config path that is not a readable document", async () => {
    const root = await privateRoot();
    const path = join(root, "bad.json");
    await writeFile(path, "{not json", { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(runConfiguredFactorySupervisor(path, new AbortController().signal, dependencies())).rejects.toThrow("factory supervisor config is invalid");
    await expect(runConfiguredFactorySupervisor(join(root, "absent.json"), new AbortController().signal, dependencies())).rejects.toBeDefined();
  });
});


describe("probeFactoryHostRunner", () => {
  test("initializes the configured runner root and reports its verdict", async () => {
    const root = await privateRoot();
    const seen: string[] = [];
    class Runner {
      constructor(readonly options: { root: string }) { seen.push(options.root); }
      async initialize(): Promise<void> {}
    }
    await probeFactoryHostRunner(parseFactorySupervisorProcessConfig(config(root)), async () => Runner);
    expect(seen).toEqual([join(root, "runner")]);

    class Refusing {
      constructor(_options: { root: string }) {}
      async initialize(): Promise<void> { throw new Error("isolation_unavailable"); }
    }
    await expect(probeFactoryHostRunner(parseFactorySupervisorProcessConfig(config(root)), async () => Refusing))
      .rejects.toThrow("isolation_unavailable");
  });

  test("the production loader really loads the container runner, and it refuses an unusable store root", async () => {
    const root = await privateRoot();
    // A regular file cannot become an artifact store, so the real runner's own
    // store preparation refuses before any container is created. That makes the
    // default loader provable on any host, with or without a live container.
    const file = join(root, "not-a-directory");
    await writeFile(file, "", { mode: 0o600 });
    await expect(probeFactoryHostRunner(parseFactorySupervisorProcessConfig(config(root, { runnerRoot: file }))))
      .rejects.toBeDefined();
  });
});

describe("runFactorySupervisorMain", () => {
  test("wires both stop signals and removes them again", async () => {
    const once: string[] = [];
    const removed: string[] = [];
    let observed: AbortSignal | undefined;
    await runFactorySupervisorMain(["bun", "supervisor-process.ts", "/run/config.json"], {
      runConfigured: async (path, signal) => { expect(path).toBe("/run/config.json"); observed = signal; },
      once: (event) => { once.push(event); },
      removeListener: (event) => { removed.push(event); },
      fail: () => { throw new Error("must not fail"); },
    });
    expect(once).toEqual(["SIGINT", "SIGTERM"]);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
    expect(observed?.aborted).toBe(false);
  });

  test("a stop signal aborts the run", async () => {
    const listeners: Array<() => void> = [];
    let aborted = false;
    await runFactorySupervisorMain(["bun", "supervisor-process.ts", "/run/config.json"], {
      runConfigured: async (_path, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        for (const listener of listeners) listener();
      },
      once: (_event, listener) => { listeners.push(listener); },
      removeListener: () => {},
      fail: () => {},
    });
    expect(aborted).toBe(true);
  });

  test("requires exactly one config path", async () => {
    const unused = { runConfigured: async () => {}, once: () => {}, removeListener: () => {}, fail: () => {} };
    await expect(runFactorySupervisorMain(["bun", "supervisor-process.ts"], unused)).rejects.toThrow("config path is required");
    await expect(runFactorySupervisorMain(["bun", "supervisor-process.ts", "a", "b"], unused)).rejects.toThrow("config path is required");
  });
});

describe("startFactorySupervisorMain", () => {
  test("runs only when this module is the process entry", () => {
    const calls: string[] = [];
    const dependenciesFor = { runConfigured: async (path: string) => { calls.push(path); }, once: () => {}, removeListener: () => {}, fail: () => {} };
    startFactorySupervisorMain(["bun", "/other/entry.ts", "/run/config.json"], import.meta.url, dependenciesFor);
    expect(calls).toEqual([]);
    startFactorySupervisorMain([], import.meta.url, dependenciesFor);
    expect(calls).toEqual([]);
  });

  test("reports a failed run through the injected failure path", async () => {
    const failures: number[] = [];
    startFactorySupervisorMain(["bun", new URL(import.meta.url).pathname, "/run/config.json"], import.meta.url, {
      runConfigured: async () => { throw new Error("boom"); },
      once: () => {}, removeListener: () => {},
      fail: () => { failures.push(1); },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(failures).toEqual([1]);
  });
});

describe("factorySupervisorProductionDependencies", () => {
  test("its wait resolves on abort and on elapse, never rejecting", async () => {
    const controller = new AbortController();
    const settled: string[] = [];
    const waiting = factorySupervisorProductionDependencies.wait(60_000, controller.signal)
      .then(() => settled.push("resolved"), () => settled.push("rejected"));
    controller.abort();
    await waiting;
    expect(settled).toEqual(["resolved"]);

    const aborted = new AbortController();
    aborted.abort();
    await factorySupervisorProductionDependencies.wait(60_000, aborted.signal);
    await factorySupervisorProductionDependencies.wait(1, new AbortController().signal);
    expect(settled).toEqual(["resolved"]);
  });

  test("builds a readiness writer for the exact host it is configured for", async () => {
    const root = await privateRoot();
    const writer = factorySupervisorProductionDependencies.createReadiness(parseFactorySupervisorProcessConfig(config(root)));
    const published = await writer.write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true } });
    expect(published).toMatchObject({ service: "host-supervisor", installationId: "installation-01", instanceId: "host-01" });

    const noHeartbeat = factorySupervisorProductionDependencies.createReadiness(parseFactorySupervisorProcessConfig(config(root, { readinessHeartbeatMs: undefined })));
    expect(await noHeartbeat.write({ lifecycle: "starting", facts: { hostKeyReady: false, runnerReady: false } })).toMatchObject({ lifecycle: "starting" });
  });
});
