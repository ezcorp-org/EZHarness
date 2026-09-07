import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRealE2e } from "../../scripts/run-real-e2e.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "run-real-e2e-test-"));
  roots.push(root);
  mkdirSync(join(root, "web"));
  return root;
}

function signalHarness() {
  const listeners = new Map<NodeJS.Signals, () => void>();
  return {
    signals: {
      on: (signal: NodeJS.Signals, listener: () => void) => listeners.set(signal, listener),
      off: (signal: NodeJS.Signals) => listeners.delete(signal),
    },
    emit: (signal: NodeJS.Signals) => listeners.get(signal)?.(),
  };
}

describe("run-real-e2e", () => {
  test("keeps its generated DB live for the child, then removes its exact DB and sidecar after exit", async () => {
    const root = sandbox();
    const dbDir = join(root, "ezcorp-e2e-generated");
    mkdirSync(dbDir);
    let release!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { release = resolve; });
    let childSawLiveDb = false;

    const run = runRealE2e("fresh-setup", [], {
      projectRoot: root,
      createTempDir: () => dbDir,
      spawn: (cmd, options) => {
        expect(cmd).toEqual([
          join(root, "web", "node_modules", ".bin", "playwright"),
          "test",
          "--config",
          "playwright.fresh-setup.config.ts",
        ]);
        childSawLiveDb = existsSync(options.env.PI_E2E_REAL_DB_PATH!);
        expect(options.env.PI_E2E_REAL_DB_GENERATED).toBe("1");
        writeFileSync(`${dbDir}.ezcorp.pid`, "child-stub");
        return { exited, kill: () => {} };
      },
    });

    await Promise.resolve();
    expect(childSawLiveDb).toBe(true);
    expect(existsSync(dbDir)).toBe(true);
    expect(existsSync(`${dbDir}.ezcorp.pid`)).toBe(true);

    release(0);
    expect(await run).toBe(0);
    expect(existsSync(dbDir)).toBe(false);
    expect(existsSync(`${dbDir}.ezcorp.pid`)).toBe(false);
  });

  test("propagates the child failure status after generated cleanup", async () => {
    const root = sandbox();
    const dbDir = join(root, "ezcorp-e2e-failing");
    mkdirSync(dbDir);

    const code = await runRealE2e("real-auth", [], {
      projectRoot: root,
      createTempDir: () => dbDir,
      spawn: (cmd) => {
        expect(cmd.slice(0, 4)).toEqual([
          join(root, "web", "node_modules", ".bin", "playwright"),
          "test",
          "--config",
          "playwright.real.config.ts",
        ]);
        return { exited: Promise.resolve(23), kill: () => {} };
      },
    });

    expect(code).toBe(23);
    expect(existsSync(dbDir)).toBe(false);
  });

  test("removes its generated DB and sidecar if Playwright cannot launch", async () => {
    const root = sandbox();
    const dbDir = join(root, "ezcorp-e2e-launch-failure");
    mkdirSync(dbDir);
    writeFileSync(`${dbDir}.ezcorp.pid`, "stale-child");

    await expect(
      runRealE2e("real-auth", [], {
        projectRoot: root,
        createTempDir: () => dbDir,
        spawn: () => {
          throw new Error("missing Playwright executable");
        },
      }),
    ).rejects.toThrow("missing Playwright executable");

    expect(existsSync(dbDir)).toBe(false);
    expect(existsSync(`${dbDir}.ezcorp.pid`)).toBe(false);
  });

  test("preserves a caller-owned DB, its sidecar, and neighboring path", async () => {
    const root = sandbox();
    const dbDir = join(root, "caller-db");
    const neighbor = join(root, "caller-db-neighbor");
    mkdirSync(dbDir);
    mkdirSync(neighbor);
    writeFileSync(`${dbDir}.ezcorp.pid`, "caller");
    let childEnv: Record<string, string | undefined> | undefined;

    const code = await runRealE2e("real-auth", [], {
      projectRoot: root,
      env: { PI_E2E_REAL_DB_PATH: dbDir, PI_E2E_REAL_DB_GENERATED: "1" },
      spawn: (_cmd, options) => {
        childEnv = options.env;
        return { exited: Promise.resolve(0), kill: () => {} };
      },
    });

    expect(code).toBe(0);
    expect(childEnv?.PI_E2E_REAL_DB_PATH).toBe(dbDir);
    expect(childEnv?.PI_E2E_REAL_DB_GENERATED).toBeUndefined();
    expect(existsSync(dbDir)).toBe(true);
    expect(existsSync(`${dbDir}.ezcorp.pid`)).toBe(true);
    expect(existsSync(neighbor)).toBe(true);
  });

  test.each(["relative-caller-db", ""])("never treats caller DB value %j as generated", async (callerDbDir) => {
    const root = sandbox();
    let createdTemp = false;
    let childDbDir: string | undefined;

    const code = await runRealE2e("real-auth", [], {
      projectRoot: root,
      env: { PI_E2E_REAL_DB_PATH: callerDbDir },
      createTempDir: () => {
        createdTemp = true;
        return join(root, "must-not-create");
      },
      spawn: (_cmd, options) => {
        childDbDir = options.env.PI_E2E_REAL_DB_PATH;
        return { exited: Promise.resolve(0), kill: () => {} };
      },
    });

    expect(code).toBe(0);
    expect(createdTemp).toBe(false);
    expect(childDbDir).toBe(callerDbDir);
  });

  test("forwards either parent signal as SIGINT and waits for child exit before cleanup", async () => {
    const root = sandbox();
    const dbDir = join(root, "ezcorp-e2e-signal");
    mkdirSync(dbDir);
    let release!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { release = resolve; });
    const harness = signalHarness();
    const killed: NodeJS.Signals[] = [];

    const run = runRealE2e("real-auth", [], {
      projectRoot: root,
      createTempDir: () => dbDir,
      signals: harness.signals,
      spawn: () => ({ exited, kill: (signal) => killed.push(signal!) }),
    });

    harness.emit("SIGTERM");
    harness.emit("SIGINT");
    expect(killed).toEqual(["SIGINT"]);
    expect(existsSync(dbDir)).toBe(true);

    release(130);
    expect(await run).toBe(130);
    expect(existsSync(dbDir)).toBe(false);
  });
});
