import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const root = join(import.meta.dir, "..");
const helper = join(root, "scripts/lib/test-file-context.sh");
const gateway = "tests/postgres/factory-gateway-process.test.ts";
const admin = "postgres://fixture:private-password@127.0.0.1:1/private_fixture";
const inspect = `console.log(JSON.stringify({ database: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname : "", git: process.env.GIT_INDEX_FILE, args: process.argv.slice(1) }))`;

function observerBin(temporary: string): string {
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), '#!/usr/bin/env bash\nif [ "$1" = test ]; then exec "$CONTEXT_REAL_BUN" -e "$CONTEXT_INSPECT"; fi\nexec "$CONTEXT_REAL_BUN" "$@"\n', { mode: 0o755 });
  return bin;
}

function run(file: string, environment: Record<string, string> = {}, args: string[] = []) {
  return Bun.spawnSync(["bash", helper, file, process.execPath, "-e", inspect, ...args], {
    cwd: root,
    env: { ...baseEnvironment, DATABASE_URL: "", FACTORY_TEST_POSTGRES_URL: admin, ...environment },
  });
}

test("gateway child receives a unique scratch database; the next normal child stays embedded", () => {
  const first = run(gateway);
  const second = run(`./${gateway}`);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  const a = JSON.parse(first.stdout.toString()).database;
  const b = JSON.parse(second.stdout.toString()).database;
  expect(a).toMatch(/^\/factory_gateway_[a-f0-9]{32}$/);
  expect(b).toMatch(/^\/factory_gateway_[a-f0-9]{32}$/);
  expect(a).not.toBe(b);
  const ordinary = run("src/factory/gateway-process.test.ts", {}, ["one value", "$(never-run)"]);
  expect(ordinary.exitCode).toBe(0);
  expect(JSON.parse(ordinary.stdout.toString())).toEqual({ database: "", args: ["one value", "$(never-run)"] });
});

test("an explicit valid gateway database remains selected", () => {
  const result = run(gateway, { DATABASE_URL: admin.replace("private_fixture", "explicit_gateway") });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).database).toBe("/explicit_gateway");
});

test("missing and invalid fixture context fail before the child and redact credentials", () => {
  const invalidEnvironments: Record<string, string>[] = [
    { FACTORY_TEST_POSTGRES_URL: "" },
    { FACTORY_TEST_POSTGRES_URL: "invalid-private-password" },
    { FACTORY_TEST_POSTGRES_URL: admin.replace("postgres:", "https:") },
    { DATABASE_URL: admin.replace("private_fixture", "unsafe-name") },
  ];
  for (const environment of invalidEnvironments) {
    const result = run(gateway, environment);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("gateway process test requires");
    expect(result.stderr.toString()).not.toContain("private-password");
  }
});

test("the actual staged hook passes gateway startup context and clears Git context", () => {
  const temporary = mkdtempSync(join(tmpdir(), "test-file-context-"));
  try {
    const bin = observerBin(temporary);
    // The mapper runs unchanged. Only the test child is replaced by an observer.
    const result = Bun.spawnSync(["bash", "-c", 'source scripts/lib/hook-lib.sh; run_staged_tests "$1"', "fixture", gateway], {
      cwd: root,
      env: { ...baseEnvironment, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "", FACTORY_TEST_POSTGRES_URL: admin, GIT_INDEX_FILE: "/must-be-cleared", CONTEXT_REAL_BUN: process.execPath, CONTEXT_INSPECT: inspect },
    });
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
    expect(observed.database).toMatch(/^\/factory_gateway_[a-f0-9]{32}$/);
    expect(observed.git).toBeUndefined();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("watchdog child keeps its own process group and records a nonzero child exit", () => {
  const temporary = mkdtempSync(join(tmpdir(), "test-file-context-watchdog-"));
  try {
    const bin = observerBin(temporary);
    const observe = `${inspect}; console.log(JSON.stringify({pid: process.pid, group: Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim())})); process.exit(7)`;
    const result = Bun.spawnSync(["bash", "-c", 'source scripts/lib/watchdog.sh; _ez_watchdog_loop() { echo "$1" > "$CONTEXT_TRACKED_PID"; }; ez_watchdog_run_file "$1" "$2/out" "$2/code" "$2/watchdog"', "fixture", gateway, temporary], {
      cwd: root,
      env: { ...baseEnvironment, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "", FACTORY_TEST_POSTGRES_URL: admin, CONTEXT_REAL_BUN: process.execPath, CONTEXT_INSPECT: observe, CONTEXT_TRACKED_PID: join(temporary, "tracked") },
    });
    expect(result.exitCode).toBe(7);
    expect(readFileSync(join(temporary, "code"), "utf8").trim()).toBe("7");
    const [context, identity] = readFileSync(join(temporary, "out"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(context.database).toMatch(/^\/factory_gateway_[a-f0-9]{32}$/);
    expect(identity.pid).toBeGreaterThan(0);
    expect(identity.group).toBe(identity.pid);
    expect(Number(readFileSync(join(temporary, "tracked"), "utf8"))).toBe(identity.pid);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the watchdog kills the stalled test and its descendant", () => {
  const temporary = mkdtempSync(join(tmpdir(), "test-file-context-kill-"));
  let identities: { pid: number; descendant: number } | undefined;
  try {
    const bin = observerBin(temporary);
    const observe = 'const child = Bun.spawn(["sleep", "60"], {stdout: "ignore", stderr: "ignore"}); console.log(JSON.stringify({pid: process.pid, descendant: child.pid})); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)';
    const result = Bun.spawnSync(["bash", "-c", 'source scripts/lib/watchdog.sh; ez_watchdog_run_file "$1" "$2/out" "$2/code" "$2/watchdog"', "fixture", gateway, temporary], {
      cwd: root,
      env: { ...baseEnvironment, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "", FACTORY_TEST_POSTGRES_URL: admin, CONTEXT_REAL_BUN: process.execPath, CONTEXT_INSPECT: observe, EZ_TEST_WATCHDOG_INTERVAL_SECS: "0.05", EZ_TEST_WATCHDOG_STALL_SECS: "0" },
    });
    expect(result.exitCode).toBe(137);
    expect(readFileSync(join(temporary, "code"), "utf8").trim()).toBe("137");
    identities = JSON.parse(readFileSync(join(temporary, "out"), "utf8"));
    expect(readFileSync(join(temporary, "watchdog"), "utf8")).toContain(`pid:     ${identities!.pid}`);
    for (const pid of [identities!.pid, identities!.descendant]) {
      const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
      expect(status === "" || status.startsWith("Z")).toBe(true);
    }
  } finally {
    // Keep a failed regression from leaving a deliberate sleeping fixture.
    if (identities) for (const pid of [identities.pid, identities.descendant]) Bun.spawnSync(["kill", "-KILL", String(pid)]);
    rmSync(temporary, { recursive: true, force: true });
  }
});
