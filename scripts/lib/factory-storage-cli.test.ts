import { describe, expect, test } from "bun:test";
import { composeEnv, parseRestartFlagArgs, RESTART_STORES_FLAG, stopThenUpInvocations, UnknownArgumentError } from "./factory-storage-cli.ts";

const HELP = "HELP TEXT PLACEHOLDER";

describe("parseRestartFlagArgs", () => {
  test("no arguments: neither flag is set", () => {
    expect(parseRestartFlagArgs([], HELP)).toEqual({ restartStores: false, help: false });
  });

  test("the restart flag sets restartStores", () => {
    expect(parseRestartFlagArgs([RESTART_STORES_FLAG], HELP)).toEqual({ restartStores: true, help: false });
  });

  test("--help sets help", () => {
    expect(parseRestartFlagArgs(["--help"], HELP)).toEqual({ restartStores: false, help: true });
  });

  test("-h also sets help", () => {
    expect(parseRestartFlagArgs(["-h"], HELP)).toEqual({ restartStores: false, help: true });
  });

  test("both flags together", () => {
    expect(parseRestartFlagArgs([RESTART_STORES_FLAG, "--help"], HELP)).toEqual({ restartStores: true, help: true });
  });

  test("an unknown argument is rejected with the caller's own help text", () => {
    expect(() => parseRestartFlagArgs(["--bogus"], HELP)).toThrow(UnknownArgumentError);
    try {
      parseRestartFlagArgs(["--bogus"], HELP);
      throw new Error("expected parseRestartFlagArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownArgumentError);
      expect((error as Error).message).toBe(`Unknown argument: --bogus\n\n${HELP}`);
    }
  });
});

describe("UnknownArgumentError", () => {
  test("names itself and carries the argument plus help text", () => {
    const error = new UnknownArgumentError("--nope", "some help");
    expect(error.name).toBe("UnknownArgumentError");
    expect(error.message).toBe("Unknown argument: --nope\n\nsome help");
  });
});

describe("composeEnv", () => {
  test("sets COMPOSE_PROJECT_NAME and omits DOCKER_HOST when none resolved", () => {
    const env = composeEnv({ dockerHost: undefined, projectName: "proj-1", baseEnv: {} });
    expect(env.COMPOSE_PROJECT_NAME).toBe("proj-1");
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  test("forwards a resolved DOCKER_HOST", () => {
    const env = composeEnv({ dockerHost: "unix:///run/user/1001/podman/podman.sock", projectName: "proj-1", baseEnv: {} });
    expect(env.DOCKER_HOST).toBe("unix:///run/user/1001/podman/podman.sock");
  });

  test("preserves baseEnv entries and drops undefined-valued ones", () => {
    const env = composeEnv({ dockerHost: undefined, projectName: "proj-1", baseEnv: { PATH: "/usr/bin", MISSING: undefined } });
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.keys(env)).not.toContain("MISSING");
  });

  test("projectName always wins over a same-named baseEnv entry", () => {
    const env = composeEnv({ dockerHost: undefined, projectName: "proj-real", baseEnv: { COMPOSE_PROJECT_NAME: "proj-stale" } });
    expect(env.COMPOSE_PROJECT_NAME).toBe("proj-real");
  });
});

describe("stopThenUpInvocations", () => {
  test("builds a stop then an up -d --wait command against exactly the given services", () => {
    const [stopInvocation, upInvocation] = stopThenUpInvocations(["factory-storage-ordinary"], {
      dockerHost: undefined,
      projectName: "proj-1",
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

  test("supports multiple services", () => {
    const [stopInvocation] = stopThenUpInvocations(["factory-storage-ordinary", "factory-storage-archive"], {
      dockerHost: undefined,
      projectName: "proj-1",
      baseEnv: {},
    });
    expect(stopInvocation.cmd.slice(-2)).toEqual(["factory-storage-ordinary", "factory-storage-archive"]);
  });

  test("both invocations share identical, resolved env", () => {
    const [stopInvocation, upInvocation] = stopThenUpInvocations(["factory-storage-ordinary"], {
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
      projectName: "proj-1",
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(upInvocation.env).toEqual(stopInvocation.env);
    expect(stopInvocation.env).toEqual({ PATH: "/usr/bin", COMPOSE_PROJECT_NAME: "proj-1", DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" });
  });
});
