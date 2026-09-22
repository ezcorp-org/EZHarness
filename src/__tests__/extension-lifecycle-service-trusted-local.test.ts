/**
 * The lifecycle SERVICE in trusted-local mode: `initialize()` must install
 * the runner's hooks and wire the lifecycle's acknowledgement dependency, so
 * that a build without the acknowledgement is refused, a build with it
 * records the approval the runner will read, verification runs under a short
 * grant derived from it, and disabling withdraws everything.
 *
 * Real PGlite, real repository, real `createTrustedLocalHooks` (the store and
 * the audit log are asserted on rows); the runner MODULE is stubbed — its
 * build returns a canned verified result and its worker answers discovery —
 * so no extension code runs here. The real in-process runner is proven by
 * `trusted-local-runner-in-process.integration.test.ts` (residual job) and
 * the trusted-local Playwright lane. This file is what gives the service's
 * trusted-local branch coverage: `*integration*` suites produce none.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { closeTestDb, getTestDb, mockDbConnection, mockRealSettings, setupTestDb } from "./helpers/test-pglite";
import { ADMIN_USER } from "./helpers/mock-request";

mockDbConnection();
mockRealSettings();

// ExtensionRegistry imports ExtensionProcess at module load and publishing a
// generation reloads the registry. Nothing here runs a subprocess.
mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class { isRunning = false; kill() {} },
  parseMemoryLimit: (_: string) => undefined,
}));

// The runner module: record what the service installs; hand out a canned
// runner only once a test has provided one.
const configured: Array<{ approvalFor: (phase: "build" | "execute", digest: string) => Promise<unknown>; audit: (event: unknown) => Promise<void> }> = [];
let fakeRunner: Record<string, unknown> | undefined;
mock.module("../extensions/trusted-local-runner", () => ({
  configureTrustedLocalRunner: (hooks: (typeof configured)[number]) => { configured.push(hooks); },
  resolveTrustedLocalRunner: async () => { if (!fakeRunner) throw new Error("this test dispatched a build without providing a runner"); return fakeRunner; },
  trustedLocalRoot: (root: string) => `${root}/.ezcorp/extension-trusted-local`,
  TRUSTED_LOCAL_ROOT: ".ezcorp/extension-trusted-local",
}));

import { validateManifest } from "@ezcorp/extension-contract";
import { trustedLocalImage } from "@ezcorp/extension-runner";
import { users } from "../db/schema";
import { listAuditLog } from "../db/queries/audit-log";
import { findTrustedLocalApproval } from "../db/queries/extension-trusted-local-approvals";
import { ExtensionRegistry } from "../extensions/registry";
import { getExtensionLifecycle, resetExtensionServices } from "../extensions/extension-lifecycle-service";
import { trustedLocalBunDigest, UNSANDBOXED_ACK_SENTENCE } from "../extensions/runner-mode";
import { digestObject } from "../extensions/v4/blobs";

const ENV = ["EZCORP_EXTENSION_RUNNER", "EZCORP_EXTENSIONS_UNSANDBOXED_ACK", "EZCORP_EXTENSION_RUNNER_SOCKET", "EZCORP_EXTENSION_RUNNER_TOKEN", "EZCORP_EXTENSION_RUNNER_TOKEN_FILE", "EZCORP_EXTENSION_BLOB_ROOT"] as const;
const previous = new Map<string, string | undefined>();
const actor = { principalId: ADMIN_USER.id, scope: "global", kind: "human" as const };
let blobRoot = "";

beforeAll(async () => {
  for (const name of ENV) { previous.set(name, process.env[name]); delete process.env[name]; }
  process.env.EZCORP_EXTENSION_RUNNER = "trusted-local";
  process.env.EZCORP_EXTENSIONS_UNSANDBOXED_ACK = UNSANDBOXED_ACK_SENTENCE;
  blobRoot = await mkdtemp(join(tmpdir(), "ez-trusted-service-blobs-"));
  process.env.EZCORP_EXTENSION_BLOB_ROOT = blobRoot;
  await setupTestDb();
  // The services below are module state. Every assertion here is about what
  // INITIALISING them does — the hooks installed, the mode read from the
  // environment set just above — so this file has to own that initialisation,
  // whatever a pooled process already built against another database.
  resetExtensionServices();
  await getTestDb().insert(users).values({ id: ADMIN_USER.id, email: ADMIN_USER.email, passwordHash: "h", name: ADMIN_USER.name, role: "admin" });
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  // Built against the database closed below, and against this file's
  // trusted-local environment. Neither survives it.
  resetExtensionServices();
  restoreModuleMocks();
  await closeTestDb();
  await rm(blobRoot, { recursive: true, force: true });
  for (const name of ENV) { const value = previous.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe("extension lifecycle service in trusted-local mode", () => {
  test("initialisation installs the runner's approval store and audit sink exactly once", async () => {
    await getExtensionLifecycle();
    await getExtensionLifecycle();
    expect(configured).toHaveLength(1);
    expect(typeof configured[0]!.approvalFor).toBe("function");
    expect(typeof configured[0]!.audit).toBe("function");
  });

  test("the installed hooks are the real store and the real audit log", async () => {
    await getExtensionLifecycle();
    const hooks = configured[0]!;
    const digest = "c".repeat(64);
    expect(await hooks.approvalFor("build", digest)).toBeNull();
    await hooks.audit({ mode: "trusted-local", approval: { digest, phase: "build", approvedBy: ADMIN_USER.id, expiresAt: Date.UTC(2030, 0, 1), omittedControls: ["filesystem-isolation"] } });
    const rows = await listAuditLog({ action: "extension.trusted_local.build" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ADMIN_USER.id, target: digest });
    expect(rows[0]!.metadata).toMatchObject({ omittedControls: ["filesystem-isolation"], expiresAt: "2030-01-01T00:00:00.000Z" });
  });

  test("the lifecycle refuses a build without the acknowledgement, records the approval with it, and withdraws it on disable", async () => {
    const lifecycle = await getExtensionLifecycle();
    const { installation, workspace } = await lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1" } });
    const input = { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "trusted-build" };

    await expect(lifecycle.build(actor, input)).rejects.toMatchObject({ code: "unsandboxed_acknowledgement_required" });
    expect(await findTrustedLocalApproval("build", workspace.sourceDigest)).toBeNull();

    const operation = await lifecycle.build(actor, { ...input, acknowledgeUnsandboxed: true });
    expect(operation.sourceDigest).toBe(workspace.sourceDigest);
    // The row the runner's authorize() will read: this installation, this
    // exact source, this human.
    expect(await findTrustedLocalApproval("build", workspace.sourceDigest)).toMatchObject({ phase: "build", digest: workspace.sourceDigest, approvedBy: ADMIN_USER.id });

    await lifecycle.disable(actor, installation.id);
    expect(await findTrustedLocalApproval("build", workspace.sourceDigest)).toBeNull();
  });

  test("running the build extends the acknowledgement to verifying the artifact, for a window shorter than the build approval", async () => {
    const lifecycle = await getExtensionLifecycle();
    const manifest = validateManifest({ schemaVersion: 4, name: `trusted-${randomUUID().slice(0, 8)}`, version: "1.0.0", description: "Trusted-local service fixture", author: { name: "Test" }, entrypoint: "extension.js", permissions: {} });
    const artifacts = { "extension.js": "export default 2" };
    const artifactDigest = digestObject(artifacts);
    // What the lifecycle in this mode expects every build to be stamped with.
    const imageDigest = trustedLocalImage(await trustedLocalBunDigest());
    fakeRunner = {
      build: async (request: { operationId: string; sourceDigest: string }) => ({ operationId: request.operationId, state: "succeeded", sourceDigest: request.sourceDigest, artifactDigest, imageDigest, manifest, evidence: { protocolVersion: 4, validatorVersion: "runner-v4.1", discoveryDigest: digestObject(manifest), tests: [{ name: "host-protocol", passed: true }] }, diagnostics: [] }),
      collectArtifacts: async () => artifacts,
      cancel: async () => {},
      inspect: async (id: string) => ({ id, state: "unknown", diagnostics: [] }),
      start: async ({ workerId }: { workerId: string }) => ({ workerId, request: async (method: string) => (method === "extension/discover" ? manifest : null), close: async () => {}, onNotification: () => () => {} }),
    };
    try {
      const { installation, workspace } = await lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 2" } });
      const operation = await lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "trusted-verify", acknowledgeUnsandboxed: true });
      const settled = await lifecycle.runBuild(actor, installation.id, operation.id);
      expect(settled.state, JSON.stringify(settled.diagnostics)).toBe("verified");

      const build = await findTrustedLocalApproval("build", workspace.sourceDigest);
      const verification = await findTrustedLocalApproval("execute", artifactDigest);
      expect(verification).toMatchObject({ phase: "execute", digest: artifactDigest, approvedBy: ADMIN_USER.id });
      // Derived from the build row (same approver) and deliberately shorter:
      // verification is immediate, release execution is a separate human act.
      expect(verification!.expiresAt).toBeLessThan(build!.expiresAt);
      expect(verification!.omittedControls).toEqual(build!.omittedControls);
    } finally {
      fakeRunner = undefined;
    }
  });
});
