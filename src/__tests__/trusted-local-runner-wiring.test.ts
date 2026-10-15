import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

/**
 * The host wiring in `src/extensions/trusted-local-runner.ts`, with the runner
 * PACKAGE replaced by a recording stub. What this pins is the contract between
 * host and package — every option the host hands the runner, the two injected
 * hooks, and the resolve-once / forget-on-failure lifecycle — without paying
 * for a real bun digest of the SDK bundle. The real construction is proven by
 * `trusted-local-runner-in-process.integration.test.ts` (residual job) and
 * the trusted-local Playwright lane; those do not produce coverage, this does.
 *
 * The tests run in FILE ORDER against the one canonical module instance, on
 * purpose: `hooks` and the memoised runner are module state, and the obvious
 * alternative — a `?fresh=` module copy per test — is a coverage trap. Bun
 * keeps ONE record per source path and the copy loaded LAST owns it, so any
 * line only an earlier copy executed (here the `.catch` reset and the
 * `approvalFor` wrapper) reads as a miss however often it ran. Measured:
 * 8 missed lines with copies, 0 without. So the lifecycle is walked once, in
 * the order a process would: unconfigured → a failed construction, forgotten
 * (the only point a second construction is legitimate, so the SDK-entry
 * override is proven there) → constructed → reused.
 */
const constructed: Array<Record<string, unknown>> = [];
const provisions: unknown[] = [];
let initializeImpl: () => Promise<void> = async () => {};
let initializeCalls = 0;

mock.module("@ezcorp/extension-runner", () => ({
  provisionToolchain: async (options: unknown) => { provisions.push(options); return { sdkFiles: { "node_modules/@ezcorp/sdk/package.json": "{}" }, toolchainFiles: { "node_modules/typescript/package.json": "{}" } }; },
  TrustedLocalRunner: class {
    constructor(public readonly options: Record<string, unknown>) { constructed.push(options); }
    async initialize(): Promise<void> { initializeCalls++; return initializeImpl(); }
    async close(): Promise<void> {}
  },
  trustedLocalImage: (digest: string) => `localhost/trusted-local@sha256:${digest}`,
  TRUSTED_LOCAL_OMITTED_CONTROLS: Object.freeze([]),
  RunnerError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));

const { getProjectRoot } = await import("../extensions/project-root");
const { trustedLocalBunDigest } = await import("../extensions/runner-mode");
const { configureTrustedLocalRunner, resetTrustedLocalRunner, resolveTrustedLocalRunner, trustedLocalRoot, TRUSTED_LOCAL_ROOT } = await import("../extensions/trusted-local-runner");

type ApprovalFor = (phase: string, digest: string) => Promise<unknown>;
const hooks = {
  approvalFor: async (phase: "build" | "execute", digest: string) => (digest.startsWith("a") ? { digest, phase, approvedBy: "user-1", expiresAt: Date.now() + 60_000, omittedControls: [] } : null),
  audit: async () => {},
};

const ENV = ["EZCORP_TRUSTED_LOCAL_ROOT", "EZ_EXTENSION_RUNNER_SDK_ENTRY"] as const;
const previous = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of ENV) { previous.set(name, process.env[name]); delete process.env[name]; }
  constructed.length = 0;
  provisions.length = 0;
  initializeCalls = 0;
  initializeImpl = async () => {};
});
afterEach(() => {
  for (const name of ENV) { const value = previous.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe("trustedLocalRoot", () => {
  test("defaults under the project root, and EZCORP_TRUSTED_LOCAL_ROOT overrides it outright", () => {
    expect(trustedLocalRoot("/srv/app")).toBe(join("/srv/app", TRUSTED_LOCAL_ROOT));
    expect(TRUSTED_LOCAL_ROOT).toBe(join(".ezcorp", "extension-trusted-local"));
    process.env.EZCORP_TRUSTED_LOCAL_ROOT = "/var/lib/ez-trusted";
    expect(trustedLocalRoot("/srv/app")).toBe("/var/lib/ez-trusted");
  });
});

describe("resolveTrustedLocalRunner, walked in a process's order", () => {
  // The walk below starts where a process starts — no hooks, no runner. The
  // module is canonical and its state outlives a test file, so in a pooled
  // run an earlier suite may already have configured it
  // (`trusted-local-runner-in-process.integration.test.ts` wires the real
  // one). Once, before the walk, not per test: the four cases build on each
  // other's state on purpose.
  beforeAll(() => resetTrustedLocalRunner());

  test("refuses with runner_unconfigured until the service installs hooks, and names the CLI case", async () => {
    await expect(resolveTrustedLocalRunner()).rejects.toMatchObject({ code: "runner_unconfigured", message: expect.stringContaining("CLI cannot build") });
    expect(constructed).toHaveLength(0);
  });

  test("a failed construction is forgotten, so the next call retries — and each attempt re-reads EZ_EXTENSION_RUNNER_SDK_ENTRY, which overrides the SDK entrypoint but never the toolchain root", async () => {
    configureTrustedLocalRunner(hooks);
    process.env.EZ_EXTENSION_RUNNER_SDK_ENTRY = "/opt/release/packages/@ezcorp/sdk/src/v4/index.ts";
    initializeImpl = async () => { throw new Error("Trusted-local Bun binary differs from pinned digest"); };
    await expect(resolveTrustedLocalRunner()).rejects.toThrow("pinned digest");
    expect(constructed).toHaveLength(1);
    // Not memoised: the same rejection again means a second construction,
    // provisioned afresh from the environment as it is at that moment.
    await expect(resolveTrustedLocalRunner()).rejects.toThrow("pinned digest");
    expect(constructed).toHaveLength(2);
    expect(initializeCalls).toBe(2);
    const override = { sdkEntrypoint: "/opt/release/packages/@ezcorp/sdk/src/v4/index.ts", toolchainRoot: getProjectRoot() };
    expect(provisions).toEqual([override, override]);
  });

  test("hands the runner exactly the host's facts: release paths from the project root, the pinned bun, the app's uid, the provisioned toolchain, and the two hooks", async () => {
    process.env.EZCORP_TRUSTED_LOCAL_ROOT = "/tmp/ez-trusted-local-test-root";
    const runner = await resolveTrustedLocalRunner();
    const projectRoot = getProjectRoot();
    expect(constructed).toHaveLength(1);
    const options = constructed[0]!;
    expect(options.root).toBe("/tmp/ez-trusted-local-test-root");
    expect(options.seccompPath).toBe(join(projectRoot, "packages", "@ezcorp", "extension-runner", "seccomp.json"));
    expect(options.bunPath).toBe(process.execPath);
    expect(options.bunDigest).toBe(await trustedLocalBunDigest());
    expect(options.dedicatedUid).toBe(process.getuid?.() ?? -1);
    // The provisioned toolchain is spread in, so the runner bundles exactly
    // what the host provisioned — from the project root, not the bundle.
    expect(options.sdkFiles).toEqual({ "node_modules/@ezcorp/sdk/package.json": "{}" });
    expect(options.toolchainFiles).toEqual({ "node_modules/typescript/package.json": "{}" });
    expect(provisions).toEqual([{ sdkEntrypoint: join(projectRoot, "packages", "@ezcorp", "sdk", "src", "v4", "index.ts"), toolchainRoot: projectRoot }]);
    expect(options.audit).toBe(hooks.audit);
    expect(initializeCalls).toBe(1);
    expect((runner as unknown as { options: unknown }).options).toBe(options);
  });

  test("resolves once and keeps handing out the same runner", async () => {
    const first = await resolveTrustedLocalRunner();
    expect(await resolveTrustedLocalRunner()).toBe(first);
    expect(constructed).toHaveLength(0);
    expect(initializeCalls).toBe(0);
  });

  test("the approvalFor the runner receives forwards the host answer, null included — the warning is a log line, not a substitute", async () => {
    const runner = (await resolveTrustedLocalRunner()) as unknown as { options: { approvalFor: ApprovalFor } };
    await expect(runner.options.approvalFor("build", "a".repeat(64))).resolves.toMatchObject({ phase: "build", approvedBy: "user-1" });
    await expect(runner.options.approvalFor("execute", "b".repeat(64))).resolves.toBeNull();
  });
});
