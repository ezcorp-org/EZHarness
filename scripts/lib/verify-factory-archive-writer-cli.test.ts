import { describe, expect, test } from "bun:test";
import {
  HELP_TEXT,
  outageLegInvocations,
  OUTAGE_LEG_SERVICES,
  parseArgs,
  RESTART_LEG_SKIPPED_MESSAGE,
  RESTART_STORES_FLAG,
  UnknownArgumentError,
} from "./verify-factory-archive-writer-cli.ts";

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
  test("names the flag and states plainly it stops then restarts the ordinary store", () => {
    expect(HELP_TEXT).toContain(RESTART_STORES_FLAG);
    expect(HELP_TEXT).toContain("STOPS then RESTARTS");
    expect(HELP_TEXT).toContain("factory-storage-ordinary");
  });

  test("does not claim to touch the archive store", () => {
    expect(HELP_TEXT).not.toContain("factory-storage-archive");
  });

  test("names the required environment variable", () => {
    expect(HELP_TEXT).toContain("EZCORP_FACTORY_STORAGE_SECRETS_DIR");
  });

  test("documents -h/--help itself", () => {
    expect(HELP_TEXT).toContain("-h, --help");
  });
});

describe("RESTART_LEG_SKIPPED_MESSAGE", () => {
  test("names the flag and why: it stops then restarts the ordinary store", () => {
    expect(RESTART_LEG_SKIPPED_MESSAGE).toContain(RESTART_STORES_FLAG);
    expect(RESTART_LEG_SKIPPED_MESSAGE).toContain("STOPS then RESTARTS the shared factory-storage-ordinary store");
  });
});

describe("outageLegInvocations", () => {
  test("restarts only factory-storage-ordinary", () => {
    expect(OUTAGE_LEG_SERVICES).toEqual(["factory-storage-ordinary"]);
  });

  test("builds a stop then an up -d --wait command against only factory-storage-ordinary", () => {
    const [stopInvocation, upInvocation] = outageLegInvocations({
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
      "factory-storage-ordinary",
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
      "factory-storage-ordinary",
    ]);
  });

  test("does not name factory-storage-archive in either invocation", () => {
    const [stopInvocation, upInvocation] = outageLegInvocations({
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.cmd).not.toContain("factory-storage-archive");
    expect(upInvocation.cmd).not.toContain("factory-storage-archive");
  });

  test("sets COMPOSE_PROJECT_NAME and omits DOCKER_HOST when the caller resolved none", () => {
    const [stopInvocation] = outageLegInvocations({
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.env.COMPOSE_PROJECT_NAME).toBe("ezcorp-factory-storage-1001");
    expect(stopInvocation.env.DOCKER_HOST).toBeUndefined();
  });

  test("forwards a resolved DOCKER_HOST", () => {
    const [stopInvocation] = outageLegInvocations({
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: {},
    });
    expect(stopInvocation.env.DOCKER_HOST).toBe("unix:///run/user/1001/podman/podman.sock");
  });

  test("preserves existing baseEnv entries and drops undefined-valued ones", () => {
    const [stopInvocation] = outageLegInvocations({
      dockerHost: undefined,
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: { PATH: "/usr/bin", MISSING: undefined },
    });
    expect(stopInvocation.env.PATH).toBe("/usr/bin");
    expect(Object.keys(stopInvocation.env)).not.toContain("MISSING");
  });

  test("both invocations of a pair share identical env", () => {
    const [stopInvocation, upInvocation] = outageLegInvocations({
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
      projectName: "ezcorp-factory-storage-1001",
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(upInvocation.env).toEqual(stopInvocation.env);
  });
});
