import { describe, expect, test } from "bun:test";
import {
  HELP_TEXT,
  parseArgs,
  RESTART_LEG_SERVICES,
  RESTART_LEG_SKIPPED_MESSAGE,
  RESTART_STORES_FLAG,
  restartLegInvocations,
  UnknownArgumentError,
} from "./verify-factory-storage-cli.ts";

describe("parseArgs", () => {
  test("no arguments: neither flag is set", () => {
    expect(parseArgs([])).toEqual({ restartStores: false, help: false });
  });

  test("--restart-stores sets restartStores", () => {
    expect(parseArgs([RESTART_STORES_FLAG])).toEqual({ restartStores: true, help: false });
  });

  test("--help sets help", () => {
    expect(parseArgs(["--help"])).toEqual({ restartStores: false, help: true });
  });

  test("-h also sets help", () => {
    expect(parseArgs(["-h"])).toEqual({ restartStores: false, help: true });
  });

  test("both flags together", () => {
    expect(parseArgs([RESTART_STORES_FLAG, "--help"])).toEqual({ restartStores: true, help: true });
  });

  test("an unknown argument is rejected, not silently ignored", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(UnknownArgumentError);
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  test("the unknown-argument error includes the help text", () => {
    try {
      parseArgs(["--nope"]);
      throw new Error("expected parseArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownArgumentError);
      expect((error as Error).message).toContain(HELP_TEXT);
    }
  });
});

describe("HELP_TEXT", () => {
  test("names the flag and states plainly that it restarts BOTH shared stores", () => {
    expect(HELP_TEXT).toContain(RESTART_STORES_FLAG);
    expect(HELP_TEXT).toContain("RESTARTS");
    expect(HELP_TEXT).toContain("BOTH shared SeaweedFS stores");
    expect(HELP_TEXT).toContain("factory-storage-ordinary");
    expect(HELP_TEXT).toContain("factory-storage-archive");
  });

  test("names the required environment variable", () => {
    expect(HELP_TEXT).toContain("EZCORP_FACTORY_STORAGE_SECRETS_DIR");
  });

  test("documents -h/--help itself", () => {
    expect(HELP_TEXT).toContain("-h, --help");
  });
});

describe("RESTART_LEG_SKIPPED_MESSAGE", () => {
  test("names the flag and why: it restarts BOTH shared stores", () => {
    expect(RESTART_LEG_SKIPPED_MESSAGE).toContain(RESTART_STORES_FLAG);
    expect(RESTART_LEG_SKIPPED_MESSAGE).toContain("RESTARTS BOTH shared SeaweedFS stores");
  });
});

describe("restartLegInvocations", () => {
  test("builds a stop then an up -d --wait command against BOTH shared services", () => {
    const [stopInvocation, upInvocation] = restartLegInvocations({
      engine: "docker",
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.cmd).toEqual([
      "docker",
      "compose",
      "-f",
      "compose.factory-storage.local.yml",
      "--profile",
      "factory-storage",
      "stop",
      ...RESTART_LEG_SERVICES,
    ]);
    expect(upInvocation.cmd).toEqual([
      "docker",
      "compose",
      "-f",
      "compose.factory-storage.local.yml",
      "--profile",
      "factory-storage",
      "up",
      "-d",
      "--wait",
      ...RESTART_LEG_SERVICES,
    ]);
  });

  test("restarts both factory-storage-ordinary and factory-storage-archive", () => {
    expect(RESTART_LEG_SERVICES).toEqual(["factory-storage-ordinary", "factory-storage-archive"]);
  });

  test("sets COMPOSE_PROJECT_NAME and omits DOCKER_HOST when the caller resolved none (docker engine)", () => {
    const [stopInvocation] = restartLegInvocations({
      engine: "docker",
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.env.COMPOSE_PROJECT_NAME).toBe("ezcorp-factory-storage-1001");
    expect(stopInvocation.env.DOCKER_HOST).toBeUndefined();
  });

  test("forwards a resolved DOCKER_HOST for the podman engine", () => {
    const [stopInvocation] = restartLegInvocations({
      engine: "podman",
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.env.DOCKER_HOST).toBe("unix:///run/user/1001/podman/podman.sock");
  });

  test("preserves existing baseEnv entries and drops undefined-valued ones", () => {
    const [stopInvocation] = restartLegInvocations({
      engine: "docker",
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: { PATH: "/usr/bin", MISSING: undefined },
    });
    expect(stopInvocation.env.PATH).toBe("/usr/bin");
    expect(Object.keys(stopInvocation.env)).not.toContain("MISSING");
  });

  test("both invocations of a pair share identical env", () => {
    const [stopInvocation, upInvocation] = restartLegInvocations({
      engine: "podman",
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(upInvocation.env).toEqual(stopInvocation.env);
  });
});
