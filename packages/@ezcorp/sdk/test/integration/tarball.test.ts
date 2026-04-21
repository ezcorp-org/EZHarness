// tarball.test.ts — end-to-end install validation for @ezcorp/sdk.
//
// Flow:
//   1. `bun pm pack` the SDK into a temp dir → produces `ezcorp-sdk-<ver>.tgz`.
//   2. Scaffold a minimal fixture extension (package.json + one .test.ts) in
//      another temp dir.
//   3. `bun add file:<tgz>` inside the fixture — exercises the real npm install
//      path (symlink/copy + exports-map resolution).
//   4. `bun test` inside the fixture — the fixture asserts the three public
//      entries (`@ezcorp/sdk`, `@ezcorp/sdk/runtime`, `@ezcorp/sdk/test`)
//      import cleanly and `defineExtension` is callable.
//   5. Assert exit code 0.
//
// Bun-only. Uses mkdtempSync/rmSync (sync) + Bun.write / Bun.spawn. No
// node:fs/promises (project rule).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SDK_DIR = join(import.meta.dir, "..", "..");

let packDir: string;
let fixtureDir: string;
let tarballPath: string;

async function run(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  packDir = mkdtempSync(join(tmpdir(), "phase3-tarball-pack-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "phase3-tarball-fixture-"));

  // Pack SDK.
  const pack = await run(["bun", "pm", "pack", "--destination", packDir], {
    cwd: SDK_DIR,
  });
  if (pack.exitCode !== 0) {
    throw new Error(
      `bun pm pack failed (exit ${pack.exitCode}):\n${pack.stdout}\n${pack.stderr}`,
    );
  }

  // Locate the produced tarball (`ezcorp-sdk-<version>.tgz`).
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    throw new Error(`no .tgz produced in ${packDir}: ${readdirSync(packDir).join(", ")}`);
  }
  tarballPath = join(packDir, tgz);

  // Scaffold fixture: minimal package.json + one Bun test asserting imports.
  await Bun.write(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "tarball-install-fixture",
        version: "0.0.0",
        type: "module",
        private: true,
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(fixtureDir, "fixture.test.ts"),
    `import { test, expect } from "bun:test";
import { defineExtension } from "@ezcorp/sdk";
import * as sdkRuntime from "@ezcorp/sdk/runtime";
import * as sdkTest from "@ezcorp/sdk/test";

test("@ezcorp/sdk: defineExtension is callable identity fn", () => {
  expect(typeof defineExtension).toBe("function");
  const cfg = { name: "x", version: "1.0.0" } as any;
  expect(defineExtension(cfg)).toBe(cfg);
});

test("@ezcorp/sdk/runtime: public helpers import", () => {
  expect(typeof sdkRuntime.findProjectRoot).toBe("function");
  expect(typeof sdkRuntime.atomicWrite).toBe("function");
  expect(typeof sdkRuntime.withLock).toBe("function");
  expect(typeof sdkRuntime.getChannel).toBe("function");
  expect(typeof sdkRuntime.fetchPermitted).toBe("function");
  expect(typeof sdkRuntime.invoke).toBe("function");
  expect(typeof sdkRuntime.PanelBuilder).toBe("function");
  expect(typeof sdkRuntime.registerLifecycleHook).toBe("function");
  expect(typeof sdkRuntime.Storage).toBe("function");
});

test("@ezcorp/sdk/test: barrel import resolves", () => {
  expect(sdkTest).toBeDefined();
});
`,
  );

  // Install tarball into fixture. Empty HOME/XDG_CACHE to avoid writing to the
  // user's global bun install state; use a scratch dir instead.
  const installCacheDir = mkdtempSync(join(tmpdir(), "phase3-tarball-cache-"));
  const install = await run(["bun", "add", `file:${tarballPath}`], {
    cwd: fixtureDir,
    env: {
      BUN_INSTALL_CACHE_DIR: installCacheDir,
    },
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `bun add file:${tarballPath} failed (exit ${install.exitCode}):\n${install.stdout}\n${install.stderr}`,
    );
  }
}, 120_000);

afterAll(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test(
  "installed @ezcorp/sdk tarball: fixture extension test suite passes",
  async () => {
    const result = await run(["bun", "test", "fixture.test.ts"], {
      cwd: fixtureDir,
    });
    if (result.exitCode !== 0) {
      console.error("fixture stdout:\n", result.stdout);
      console.error("fixture stderr:\n", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // Bun emits test summary to stderr: `N pass` should appear, `0 fail`.
    expect(result.stderr).toMatch(/\d+ pass/);
    expect(result.stderr).not.toMatch(/[1-9]\d* fail/);
  },
  60_000,
);
