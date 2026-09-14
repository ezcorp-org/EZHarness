/**
 * The wiring the independent validation found missing: the host must actually
 * call the factory composition root.
 *
 * `startFactoryRuntime` existed, composed, probed, and opened admission, and no
 * production code path invoked it. A flag-on installation therefore sat at
 * `booting / factory-services-pending` for the process lifetime and every
 * `/api/factories/*` route answered 503, with nothing in the code saying so.
 *
 * These assertions are about what the HOST does, not about what the composition
 * does with what it is given: the flag decides whether anything starts, the
 * stop is registered on the path that starts, a refusal degrades readiness with
 * a named reason instead of taking the host down, and the store and bounds the
 * host owns are the ones handed over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReadiness, resetReadiness } from "$server/readiness";
import type { FactoryBootConfig } from "$server/factory/boot";

const startFactoryInstallation = vi.fn();

vi.mock("$server/factory/installation-startup", () => ({
  startFactoryInstallation: (...args: unknown[]) => startFactoryInstallation(...args),
}));

const { startFactoryForHost, startFactoryIfEnabled } = await import("$lib/server/factory-boot");

function report(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-01",
    installationId: "installation-01",
    admissionOpen: true,
    probes: [],
    seams: [],
    heldWorkers: [{ role: "stop-settlement", seam: "physical-stopper", workPackage: "W03", reason: "held" }],
    workers: [{ name: "run-projection", running: true }, { name: "attempt-dispatch", running: false }],
    ...overrides,
  };
}

function startup() {
  const stop = vi.fn(async () => {});
  return { stop, handle: { runtime: { report: () => report() }, stop } };
}

const boot: FactoryBootConfig = {
  enabled: true, requireSandbox: true, installationId: "installation-01",
  secretsDir: "/run/secrets", projectRoot: "/srv/project", grantableRoots: ["/srv/project"],
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    database: {} as never,
    databaseUrl: "postgres://product",
    signal: new AbortController().signal,
    boot,
    registerTeardown: vi.fn(),
    log: { info: vi.fn(), error: vi.fn() } as unknown as Pick<Console, "info" | "error">,
    ...overrides,
  };
}

beforeEach(() => {
  startFactoryInstallation.mockReset();
  resetReadiness();
});

afterEach(() => {
  resetReadiness();
});

describe("startFactoryIfEnabled", () => {
  it("starts nothing at all when the flag is off", async () => {
    const registerTeardown = vi.fn();
    const result = await startFactoryIfEnabled({
      ...dependencies({ registerTeardown }),
      boot: { ...boot, enabled: false },
    } as never);
    expect(result).toBeNull();
    expect(startFactoryInstallation).not.toHaveBeenCalled();
    expect(registerTeardown).not.toHaveBeenCalled();
    // No service started means readiness was never touched by the factory.
    expect(getReadiness().reason).toBeUndefined();
  });

  it("calls the composition root when the flag is on", async () => {
    const running = startup();
    startFactoryInstallation.mockResolvedValue(running.handle);
    const result = await startFactoryIfEnabled({ ...dependencies(), boot } as never);
    expect(result).toBe(running.handle);
    expect(startFactoryInstallation).toHaveBeenCalledTimes(1);
  });
});

describe("startFactoryForHost", () => {
  it("hands the composition the host's database, bounds, and stop signal", async () => {
    const running = startup();
    startFactoryInstallation.mockResolvedValue(running.handle);
    const controller = new AbortController();
    const database = { handle: "database" } as never;

    await startFactoryForHost(dependencies({ database, signal: controller.signal }) as never, {
      EZCORP_FACTORY_INTERPRETER_BUILD: "build-9",
      EZCORP_FACTORY_INTERPRETER_COMPATIBILITY: "3",
      EZCORP_FACTORY_RESOURCE_CLASSES: " cpu , gpu ",
    });

    const passed = startFactoryInstallation.mock.calls[0]![0] as {
      host: { database: unknown; runOptions: Record<string, unknown>; availableResourceClasses: string[] };
      databaseUrl: string; signal: AbortSignal; boot: FactoryBootConfig;
    };
    expect(passed.host.database).toBe(database);
    // The object store is NOT host-supplied: it comes from `storage.ordinary`
    // in the startup document, so nothing here can root it by accident.
    expect(passed.host).not.toHaveProperty("blobs");
    expect(passed.host.runOptions).toMatchObject({ interpreterBuild: "build-9", interpreterCompatibility: "3" });
    expect(passed.host.availableResourceClasses).toEqual(["cpu", "gpu"]);
    expect(passed.databaseUrl).toBe("postgres://product");
    expect(passed.signal).toBe(controller.signal);
    expect(passed.boot).toBe(boot);
  });

  it("uses documented defaults when the environment names none", async () => {
    startFactoryInstallation.mockResolvedValue(startup().handle);
    await startFactoryForHost(dependencies() as never, {});
    const passed = startFactoryInstallation.mock.calls[0]![0] as { host: { runOptions: Record<string, unknown>; availableResourceClasses: string[] } };
    expect(passed.host.runOptions).toMatchObject({ interpreterBuild: "factory-interpreter-1", interpreterCompatibility: "1" });
    expect(passed.host.availableResourceClasses).toEqual(["cpu"]);
  });

  it("registers the stop so a shutdown drains the roles before the database closes", async () => {
    const running = startup();
    startFactoryInstallation.mockResolvedValue(running.handle);
    const registerTeardown = vi.fn();
    await startFactoryForHost(dependencies({ registerTeardown }) as never, {});
    expect(registerTeardown).toHaveBeenCalledWith("factory-runtime", expect.any(Function));

    await (registerTeardown.mock.calls[0]![1] as () => Promise<void>)();
    expect(running.stop).toHaveBeenCalledTimes(1);
  });

  it("reports what runs and what is held, so the gap is visible without reading code", async () => {
    startFactoryInstallation.mockResolvedValue(startup().handle);
    const log = { info: vi.fn(), error: vi.fn() };
    await startFactoryForHost(dependencies({ log }) as never, {});
    expect(log.info).toHaveBeenCalledWith("[factory] composed", {
      tenantId: "tenant-01",
      running: ["run-projection"],
      held: ["stop-settlement"],
    });
  });

  it("routes a role failure to the host log rather than losing it", async () => {
    startFactoryInstallation.mockResolvedValue(startup().handle);
    const log = { info: vi.fn(), error: vi.fn() };
    await startFactoryForHost(dependencies({ log }) as never, {});
    const passed = startFactoryInstallation.mock.calls[0]![0] as { host: { report: (role: string, error: unknown) => void } };
    passed.host.report("attempt-dispatch", new Error("queue unavailable"));
    expect(log.error).toHaveBeenCalledWith("[factory] background role failed", { role: "attempt-dispatch", error: "Error: queue unavailable" });
  });

  it("degrades readiness with the composition's own code and keeps the host serving", async () => {
    startFactoryInstallation.mockRejectedValue(Object.assign(new Error("Factory startup requires unavailable services: temporal."), { code: "factory-services-unavailable" }));
    const registerTeardown = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };

    // It resolves: a factory that cannot compose must not take the host down.
    expect(await startFactoryForHost(dependencies({ registerTeardown, log }) as never, {})).toBeNull();
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-services-unavailable" });
    expect((getReadiness().detail as { message: string }).message).toContain("temporal");
    expect(registerTeardown).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it("names an untyped failure rather than reporting no reason", async () => {
    startFactoryInstallation.mockRejectedValue(new Error("boom"));
    expect(await startFactoryForHost(dependencies() as never, {})).toBeNull();
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-composition-failed" });

    startFactoryInstallation.mockRejectedValue("not an error");
    expect(await startFactoryForHost(dependencies() as never, {})).toBeNull();
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-composition-failed" });
    expect((getReadiness().detail as { message: string }).message).toBe("Factory composition failed.");
  });
});
