import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import {
  FACTORY_SECRET_ENV_SCHEMA,
  FactorySecretEnvError,
  loadFactorySecretEnvironment,
  parseFactorySecretEnvManifest,
  runFactorySecretEnv,
  startFactorySecretEnv,
  type FactorySecretEnvDependencies,
  type FactorySecretEnvManifest,
} from "./secret-env";

let root: string;
beforeEach(async () => { root = await makeFactoryPrivateRoot(); });
afterEach(async () => { await removeFactoryPrivateRoot(root); });

async function rejection(work: Promise<unknown>): Promise<Error> {
  try { await work; }
  catch (error) { return error as Error; }
  throw new Error("expected a rejection");
}

function refusal(work: () => unknown): Error {
  try { work(); }
  catch (error) { return error as Error; }
  throw new Error("expected a refusal");
}

async function secret(name: string, value: string | Uint8Array, mode = 0o600): Promise<string> {
  return writeModeFile(join(root, name), value, mode);
}

async function manifest(variables: Record<string, string>, name = "secret-env.json"): Promise<string> {
  return secret(name, JSON.stringify({ schemaVersion: FACTORY_SECRET_ENV_SCHEMA, variables }));
}

describe("parseFactorySecretEnvManifest", () => {
  const good: FactorySecretEnvManifest = { schemaVersion: FACTORY_SECRET_ENV_SCHEMA, variables: { DATABASE_URL: "/run/secrets/db" } };

  test("returns the manifest with frozen variables", () => {
    const parsed = parseFactorySecretEnvManifest(good);
    expect(parsed).toEqual(good);
    expect(Object.isFrozen(parsed.variables)).toBe(true);
  });

  test("accepts 32 variables and refuses 33", () => {
    const variables = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`V${index}`, `/s/${index}`]));
    expect(Object.keys(parseFactorySecretEnvManifest({ ...good, variables: variables(32) }).variables)).toHaveLength(32);
    expect(refusal(() => parseFactorySecretEnvManifest({ ...good, variables: variables(33) })).message).toBe("The secret environment manifest names an invalid variable or path.");
  });

  test("refuses a malformed envelope", () => {
    for (const value of [null, undefined, "text", 1, [], {}, { schemaVersion: FACTORY_SECRET_ENV_SCHEMA }, { ...good, extra: 1 }, { ...good, schemaVersion: "factory.secret-env.v2" }, { ...good, variables: null }, { ...good, variables: [] }, { ...good, variables: "DATABASE_URL" }]) {
      const error = refusal(() => parseFactorySecretEnvManifest(value));
      expect(error).toBeInstanceOf(FactorySecretEnvError);
      expect(error.name).toBe("FactorySecretEnvError");
      expect(error.message).toBe("The secret environment manifest is invalid.");
    }
  });

  test("refuses bad variable names and non-absolute or unnormalized paths", () => {
    for (const variables of [{}, { lower: "/a" }, { "1ABC": "/a" }, { "A-B": "/a" }, { [`A${"B".repeat(64)}`]: "/a" }, { A: "relative/path" }, { A: "/a/../b" }, { A: "/a/" }, { A: 7 }]) {
      expect(refusal(() => parseFactorySecretEnvManifest({ ...good, variables })).message).toBe("The secret environment manifest names an invalid variable or path.");
    }
    expect(Object.keys(parseFactorySecretEnvManifest({ ...good, variables: { [`A${"B".repeat(63)}`]: "/a" } }).variables)).toHaveLength(1);
  });
});

describe("loadFactorySecretEnvironment", () => {
  test("reads each private file into its variable and strips one trailing newline", async () => {
    const path = await manifest({
      DATABASE_URL: await secret("db", "postgres://u:p@h/db\n"),
      EZCORP_JWT_SECRET: await secret("jwt", "jwt-value\r\n"),
      EZCORP_ENCRYPTION_SALT: await secret("salt", "salt"),
    });
    const environment = await loadFactorySecretEnvironment(path);
    expect(environment).toEqual({ DATABASE_URL: "postgres://u:p@h/db", EZCORP_JWT_SECRET: "jwt-value", EZCORP_ENCRYPTION_SALT: "salt" });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  test("refuses a multi-line, empty, or NUL-bearing value by variable name only", async () => {
    for (const [value, file] of [["line1\nline2", "multi"], ["\n", "empty"], ["a\u0000b", "nul"], ["a\rb", "cr"], ["value\n\n", "two-newlines"]] as const) {
      const error = await rejection(loadFactorySecretEnvironment(await manifest({ EZCORP_ENCRYPTION_SECRET: await secret(file, value) }, `${file}.json`)));
      expect(error).toBeInstanceOf(FactorySecretEnvError);
      expect(error.message).toBe("The secret for EZCORP_ENCRYPTION_SECRET is empty or spans lines.");
    }
  });

  test("refuses a secret file readable by others, naming the variable and never the value", async () => {
    const error = await rejection(loadFactorySecretEnvironment(await manifest({ DATABASE_URL: await secret("db", "super-secret-value", 0o644) })));
    expect(error).toBeInstanceOf(FactorySecretEnvError);
    expect(error.message).toBe("The secret for DATABASE_URL cannot be read privately.");
    expect(error.message).not.toContain("super-secret-value");
  });

  test("refuses a missing secret file, an over-limit file, and invalid UTF-8", async () => {
    expect((await rejection(loadFactorySecretEnvironment(await manifest({ A: join(root, "absent") }, "a.json")))).message).toBe("The secret for A cannot be read privately.");
    expect((await rejection(loadFactorySecretEnvironment(await manifest({ B: await secret("big", "x".repeat(16 * 1024 + 1)) }, "b.json")))).message).toBe("The secret for B cannot be read privately.");
    expect(await loadFactorySecretEnvironment(await manifest({ C: await secret("max", "x".repeat(16 * 1024)) }, "c.json"))).toEqual({ C: "x".repeat(16 * 1024) });
    expect((await rejection(loadFactorySecretEnvironment(await manifest({ D: await secret("bad-utf8", new Uint8Array([0xc3, 0x28])) }, "d.json")))).message).toBe("The secret for D cannot be read privately.");
  });

  test("refuses a manifest that is missing, not private, or not JSON", async () => {
    const unreadable = "The secret environment manifest cannot be read privately.";
    expect((await rejection(loadFactorySecretEnvironment(join(root, "absent.json")))).message).toBe(unreadable);
    expect((await rejection(loadFactorySecretEnvironment(await secret("open.json", JSON.stringify({ schemaVersion: FACTORY_SECRET_ENV_SCHEMA, variables: { A: "/a" } }), 0o644)))).message).toBe(unreadable);
    expect((await rejection(loadFactorySecretEnvironment(await secret("broken.json", "{not json")))).message).toBe(unreadable);
  });

  test("refuses a manifest under a world-writable ancestor such as /tmp", async () => {
    expect((await rejection(loadFactorySecretEnvironment(join(tmpdir(), "w16-no-such-manifest.json")))).message).toBe("The secret environment manifest cannot be read privately.");
  });

  test("passes a manifest shape error through unchanged", async () => {
    const error = await rejection(loadFactorySecretEnvironment(await secret("shape.json", JSON.stringify({ schemaVersion: "other", variables: {} }))));
    expect(error).toBeInstanceOf(FactorySecretEnvError);
    expect(error.message).toBe("The secret environment manifest is invalid.");
  });

  test("refuses a secret in a non-private directory", async () => {
    await mkdir(join(root, "shared"), { mode: 0o755 });
    const path = await writeModeFile(join(root, "shared", "db"), "value");
    await chmod(join(root, "shared"), 0o755);
    expect((await rejection(loadFactorySecretEnvironment(await manifest({ DATABASE_URL: path })))).message).toBe("The secret for DATABASE_URL cannot be read privately.");
  });
});

interface Recorder {
  dependencies: FactorySecretEnvDependencies;
  reports: string[];
  exits: number[];
  spawned: { command: readonly string[]; env: Record<string, string> }[];
  kills: NodeJS.Signals[];
  listeners: Map<NodeJS.Signals, () => void>;
}

function recorder(childCode = 0, env: Record<string, string | undefined> = { PATH: "/bin", UNSET: undefined }): Recorder {
  const record: Recorder = { reports: [], exits: [], spawned: [], kills: [], listeners: new Map(), dependencies: undefined as never };
  record.dependencies = {
    spawn: (command, childEnv) => { record.spawned.push({ command, env: childEnv }); return { exited: Promise.resolve(childCode), kill: (signal) => { record.kills.push(signal); } }; },
    on: (signal, listener) => { record.listeners.set(signal, listener); },
    exit: (code) => { record.exits.push(code); },
    report: (message) => { record.reports.push(message); },
    env,
  };
  return record;
}

describe("runFactorySecretEnv", () => {
  const usage = "usage: secret-env.ts <manifest.json> -- <command> [args...]";

  test("refuses malformed argv with usage and exit 64", async () => {
    for (const argv of [[], ["m.json"], ["m.json", "cmd"], ["m.json", "--"], ["m.json", "x", "--", "cmd"], ["--", "cmd"], ["", "--", "cmd"]]) {
      const record = recorder();
      await runFactorySecretEnv(argv, record.dependencies);
      expect(record.reports).toEqual([usage]);
      expect(record.exits).toEqual([64]);
      expect(record.spawned).toEqual([]);
    }
  });

  test("a load failure reports the reason and exits 78 without spawning", async () => {
    const record = recorder();
    await runFactorySecretEnv([join(root, "absent.json"), "--", "cmd"], record.dependencies);
    expect(record.reports).toEqual(["[secret-env] The secret environment manifest cannot be read privately."]);
    expect(record.exits).toEqual([78]);
    expect(record.spawned).toEqual([]);
  });

  test("spawns the command with the secrets over the defined environment and exits with its code", async () => {
    const path = await manifest({ DATABASE_URL: await secret("db", "postgres://secret\n"), PATH: await secret("path", "/secret/bin") });
    const record = recorder(17, { PATH: "/bin", HOME: "/home/x", UNSET: undefined });
    await runFactorySecretEnv([path, "--", "bun", "web/build/index.js", "--", "tail"], record.dependencies);
    expect(record.spawned).toEqual([{ command: ["bun", "web/build/index.js", "--", "tail"], env: { PATH: "/secret/bin", HOME: "/home/x", DATABASE_URL: "postgres://secret" } }]);
    expect("UNSET" in record.spawned[0]!.env).toBe(false);
    expect(record.exits).toEqual([17]);
    expect(record.reports).toEqual([]);
  });

  test("forwards SIGTERM and SIGINT to the child", async () => {
    const path = await manifest({ A: await secret("a", "v") });
    const record = recorder();
    await runFactorySecretEnv([path, "--", "cmd"], record.dependencies);
    expect([...record.listeners.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    record.listeners.get("SIGINT")!();
    record.listeners.get("SIGTERM")!();
    expect(record.kills).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("startFactorySecretEnv", () => {
  const script = join(import.meta.dir, "secret-env.ts");
  const moduleUrl = pathToFileURL(script).href;

  test("does nothing when imported rather than run", () => {
    const record = recorder();
    expect(startFactorySecretEnv(["bun"], moduleUrl, record.dependencies)).toBeUndefined();
    expect(startFactorySecretEnv(["bun", "/other/entry.ts", "m", "--", "c"], moduleUrl, record.dependencies)).toBeUndefined();
    expect(record.exits).toEqual([]);
  });

  test("runs with the arguments after the script when it is the entry", async () => {
    const record = recorder();
    await startFactorySecretEnv(["bun", script, "only-manifest"], moduleUrl, record.dependencies);
    expect(record.exits).toEqual([64]);
  });

  describe("with the production dependencies", () => {
    let exitSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;
    const baseline = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };

    beforeEach(() => {
      exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
      errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const listener of process.listeners(signal)) if (!baseline[signal].includes(listener)) process.removeListener(signal, listener);
      }
    });

    test("reports usage on stderr and exits 64", async () => {
      await startFactorySecretEnv(["bun", script, "only-manifest"], moduleUrl);
      expect(errorSpy).toHaveBeenCalledWith("usage: secret-env.ts <manifest.json> -- <command> [args...]");
      expect(exitSpy).toHaveBeenCalledWith(64);
    });

    test("spawns a real child that sees the secret and exits with the child's code", async () => {
      const path = await manifest({ W16_SECRET_PROBE: await secret("probe", "probe-value\n") });
      await startFactorySecretEnv(["bun", script, path, "--", process.execPath, "-e", "process.exit(process.env.W16_SECRET_PROBE === 'probe-value' ? 7 : 3)"], moduleUrl);
      expect(exitSpy).toHaveBeenCalledWith(7);
    });

    test("a forwarded SIGTERM stops the real child", async () => {
      const path = await manifest({ W16_SECRET_PROBE: await secret("probe", "v") });
      const running = startFactorySecretEnv(["bun", script, path, "--", process.execPath, "-e", "setInterval(() => {}, 1000)"], moduleUrl)!;
      let forward: (() => void) | undefined;
      while (!forward) {
        forward = process.listeners("SIGTERM").find((listener) => !baseline.SIGTERM.includes(listener)) as (() => void) | undefined;
        if (!forward) await Bun.sleep(5);
      }
      forward();
      await running;
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy.mock.calls[0]![0]).not.toBe(0);
    });
  });
});
