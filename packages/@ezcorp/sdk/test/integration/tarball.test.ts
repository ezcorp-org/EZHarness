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
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const SDK_DIR = join(import.meta.dir, "..", "..");
const CONTRACT_DIR = join(SDK_DIR, "../extension-contract");

let packDir: string;
let fixtureDir: string;
let installCacheDir: string | undefined;
let linkInstallDir: string | undefined;
let linkedDependencies: Array<{ packageName: string; directory: string }>;
let tarballPath: string;

function installedDirectDependencies(packageRoot: string): Array<{ packageName: string; directory: string }> {
  const ownerManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  return Object.entries(ownerManifest.dependencies ?? {})
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([packageName, declaredVersion]) => {
      if (!/^\d+\.\d+\.\d+$/.test(declaredVersion)) {
        throw new Error(`${packageRoot}/package.json must pin ${packageName}, got ${declaredVersion}`);
      }
      const manifestPath = requireFromPackage
        .resolve
        .paths(packageName)
        ?.map((nodeModules) => join(nodeModules, packageName, "package.json"))
        .find(existsSync);
      if (!manifestPath) {
        throw new Error(`could not find installed ${packageName} from ${packageRoot} dependencies`);
      }
      const resolvedManifestPath = realpathSync(manifestPath);
      const manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name !== packageName || manifest.version !== declaredVersion) {
        throw new Error(
          `installed ${packageName}@${manifest.version ?? "missing"} does not match declared ${declaredVersion}`,
        );
      }
      return { packageName, directory: dirname(resolvedManifestPath) };
    });
}

function linkedDirectDependencies(): Array<{ packageName: string; directory: string }> {
  const dependencies = new Map<string, string>();
  for (const packageRoot of [SDK_DIR, CONTRACT_DIR]) {
    for (const { packageName, directory } of installedDirectDependencies(packageRoot)) {
      const existingDirectory = dependencies.get(packageName);
      if (existingDirectory && existingDirectory !== directory) {
        throw new Error(`conflicting installed paths for ${packageName}`);
      }
      dependencies.set(packageName, directory);
    }
  }
  return [...dependencies].map(([packageName, directory]) => ({ packageName, directory }));
}

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
  const pack = await run([process.execPath, "pm", "pack", "--destination", packDir], {
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
  const contractPack = await run([process.execPath, "pm", "pack", "--destination", packDir], { cwd: CONTRACT_DIR });
  if (contractPack.exitCode !== 0) throw new Error(`Contract pack failed: ${contractPack.stderr}`);
  const contractTarball = readdirSync(packDir).find(file => file.startsWith("ezcorp-extension-contract-") && file.endsWith(".tgz"));
  if (!contractTarball) throw new Error("Contract tarball was not produced");
  linkedDependencies = linkedDirectDependencies();

  // Scaffold fixture: minimal package.json + one Bun test asserting imports.
  const overrides: Record<string, string> = {
    "@ezcorp/extension-contract": `file:${join(packDir, contractTarball)}`,
  };
  for (const { packageName } of linkedDependencies) {
    overrides[packageName] = `link:${packageName}`;
  }
  await Bun.write(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "tarball-install-fixture",
        version: "0.0.0",
        type: "module",
        private: true,
        // The SDK and contract still install from fresh tarballs. Link each direct,
        // exact dependency from their resolved local installs so this export-surface
        // test does not turn into a public registry availability test.
        overrides,
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
import * as sdkV4 from "@ezcorp/sdk/v4";

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
test("@ezcorp/sdk/v4: contract and runtime import from packed dependencies", () => {
  expect(typeof sdkV4.defineExtension).toBe("function");
  expect(typeof sdkV4.createRuntimeExtension).toBe("function");
  expect(sdkV4.validateManifest({schemaVersion:4,name:"fixture",version:"1.0.0",description:"Fixture",author:{name:"Test"},permissions:{}}).name).toBe("fixture");
});
`,
  );

  // Install tarball into fixture with an isolated Bun cache. The closed registry
  // proves this fixture uses its local archives and linked locked dependency.
  installCacheDir = mkdtempSync(join(tmpdir(), "phase3-tarball-cache-"));
  linkInstallDir = mkdtempSync(join(tmpdir(), "phase3-tarball-links-"));
  const linkEnv = {
    BUN_INSTALL_CACHE_DIR: installCacheDir,
    BUN_INSTALL: linkInstallDir,
  };
  for (const { packageName, directory } of linkedDependencies) {
    const linked = await run([process.execPath, "link"], {
      cwd: directory,
      env: linkEnv,
    });
    if (linked.exitCode !== 0) {
      throw new Error(`bun link ${packageName} failed (exit ${linked.exitCode}):\n${linked.stderr}`);
    }
  }
  const install = await run([
    process.execPath,
    "add",
    "--registry",
    "http://127.0.0.1:9",
    `file:${join(packDir, contractTarball)}`,
    `file:${tarballPath}`,
  ], {
    cwd: fixtureDir,
    env: linkEnv,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `bun add file:${tarballPath} failed (exit ${install.exitCode}):\n${install.stdout}\n${install.stderr}`,
    );
  }
}, 120_000);

afterAll(() => {
  for (const directory of [packDir, fixtureDir, installCacheDir, linkInstallDir]) {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "installed @ezcorp/sdk tarball: fixture extension test suite passes",
  async () => {
    const result = await run([process.execPath, "test", "fixture.test.ts"], {
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
