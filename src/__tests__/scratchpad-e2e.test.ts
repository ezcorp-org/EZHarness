import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();


mock.module("$lib/server/context", () => ({
  getExecutor: () => ({ listAgents: () => [] }),
  getBus: () => ({ emit: () => {}, on: () => () => {} }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
  ensureInitialized: async () => {},
}));

mock.module("$server/db/connection", () => {
  const { getDb } = require("../db/connection");
  return { getDb };
});

mock.module("../../web/src/routes/api/mentions/search/$types", () => ({}));
mock.module("../../web/src/routes/api/extensions/[id]/audit/$types", () => ({}));
mock.module("../../web/src/routes/api/extensions/[id]/$types", () => ({}));

import { ensureBundledExtensions } from "../extensions/bundled";
import { createUser } from "../db/queries/users";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PodmanRunner, buildLimits, DEFAULT_IMAGE, provisionToolchain } from "@ezcorp/extension-runner";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { ExtensionLifecycle, FileBlobStore } from "../extensions/v4";
import { publishExtensionGeneration, verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";
import { requestedReleaseGrants } from "../extensions/extension-control";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { getProjectRoot } from "../extensions/project-root";
import { getExtensionByName } from "../db/queries/extensions";
import { GET as mentionsSearchGet } from "../../web/src/routes/api/mentions/search/+server";
import { GET as extensionAuditGet } from "../../web/src/routes/api/extensions/[id]/audit/+server";

let ADMIN_USER = { id: "", role: "admin", email: "a@t", name: "Admin" };
let root: string;
let runner: PodmanRunner;
let lifecycle: ExtensionLifecycle;
let installationId: string;
const actor = () => ({ principalId: ADMIN_USER.id, scope: "global", kind: "human" as const });

function makeRequest(url: string, params?: Record<string, string>): any {
  const u = new URL(url, "http://test");
  return {
    url: u,
    locals: { user: ADMIN_USER },
    params: params ?? Object.fromEntries(u.searchParams.entries()),
    request: new Request(u.toString()),
  };
}

async function jsonFromResponse(res: Response): Promise<unknown> {
  return res.json();
}

beforeAll(async () => {
  await setupTestDb();
  const user = await createUser({ email: "scratchpad-admin@example.com", name: "Admin", passwordHash: "test" });
  ADMIN_USER = { ...ADMIN_USER, id: user.id };
  root = await mkdtemp(join(tmpdir(), "scratchpad-release-"));
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
  lifecycle = new ExtensionLifecycle({
    repository: new DatabaseLifecycleRepository(getTestDb()), blobs: new FileBlobStore(join(root, "blobs")),
    runner, buildLimits, runnerProfile: "podman-v1", runnerImageDigest: DEFAULT_IMAGE, validatorVersion: "runner-v4.1",
    authorize: async identity => { if (identity.principalId !== ADMIN_USER.id) throw new Error("Unknown test principal"); },
    verifyCandidate: release => verifyExtensionCandidate(runner, release),
    publish: publishExtensionGeneration,
  });
}, 120000);

afterAll(async () => {
  await runner?.close();
  restoreModuleMocks();
  await closeTestDb();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("scratchpad e2e: verified release → approval → mention-picker → audit → disable", () => {
  test("scratchpad stays absent until its exact isolated release receives approval", async () => {
    await ensureBundledExtensions();
    expect(await getExtensionByName("scratchpad")).toBeNull();
    const { files } = await snapshotFirstPartyExtension(getProjectRoot(), "scratchpad");
    const created = await lifecycle.createWorkspace(actor(), { files });
    installationId = created.installation.id;
    const operation = await lifecycle.build(actor(), { installationId, workspaceId: created.workspace.id, expectedRevision: 1, idempotencyKey: "scratchpad-build" });
    const built = await lifecycle.runBuild(actor(), installationId, operation.id);
    expect(built.diagnostics).toEqual([]);
    expect(built.state).toBe("verified");
    expect(await getExtensionByName("scratchpad")).toBeNull();
    const state = await lifecycle.inspect(actor(), installationId);
    const release = state.releases[built.releaseId!]!;
    const approval = await lifecycle.requestApproval(actor(), { installationId, releaseId: release.id, grants: requestedReleaseGrants(release.manifest), expectedActiveReleaseId: null });
    await expect(lifecycle.approve({ ...actor(), kind: "agent" }, installationId, approval.id, true)).rejects.toThrow();
    await lifecycle.approve(actor(), installationId, approval.id, true);
    await lifecycle.activate(actor(), { installationId, approvalId: approval.id, idempotencyKey: "scratchpad-activate" });
    const row = await getExtensionByName("scratchpad");
    expect(row?.id).toBe(installationId);
    expect(row?.enabled).toBe(true);
    expect(row?.source).toBe("release-v4");
    expect((row?.grantedPermissions as { storage?: boolean } | undefined)?.storage).toBe(true);
  }, 120000);

  test("mention-picker (type=ext) surfaces scratchpad as an extension", async () => {
    await ensureBundledExtensions();
    const event = makeRequest("/api/mentions/search?type=ext&q=scratch");
    const res = await mentionsSearchGet(event);
    const body = await jsonFromResponse(res) as Array<{ name: string; kind: string }>;
    const hit = body.find((r) => r.name === "scratchpad");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("extension");
  });

  test("mention-picker (type=ext) no longer shows scratchpad as a built-in category", async () => {
    await ensureBundledExtensions();
    const event = makeRequest("/api/mentions/search?type=ext&q=scratchpad");
    const res = await mentionsSearchGet(event);
    const body = await jsonFromResponse(res) as Array<{ name: string; kind: string }>;
    const scratchpadRows = body.filter((r) => r.name === "scratchpad");
    expect(scratchpadRows).toHaveLength(1);
  });

  test("audit endpoint returns the activation row for the scratchpad extension", async () => {
    await ensureBundledExtensions();
    const row = await getExtensionByName("scratchpad");
    const event = {
      params: { id: row!.id },
      locals: { user: ADMIN_USER },
      url: new URL(`http://test/api/extensions/${row!.id}/audit`),
    } as any;
    const res = await extensionAuditGet(event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res) as { entries: Array<{ action: string; target: string }> };
    expect(Array.isArray(body.entries)).toBe(true);
    const installRows = body.entries.filter((e) => e.action === "ext:activated");
    expect(installRows.length).toBeGreaterThanOrEqual(1);
    for (const r of installRows) expect(r.target).toBe(row!.id);
  });

  test("disabling scratchpad in DB drops it from the mention-picker", async () => {
    await ensureBundledExtensions();
    const row = await getExtensionByName("scratchpad");
    await lifecycle.disable(actor(), row!.id);
    const event = makeRequest("/api/mentions/search?type=ext&q=scratch");
    const res = await mentionsSearchGet(event);
    const body = await jsonFromResponse(res) as Array<{ name: string }>;
    expect(body.some((result) => result.name === "scratchpad")).toBe(false);
    const state = await lifecycle.inspect(actor(), installationId);
    expect(state.installation.enabled).toBe(false);
    expect(Object.keys(state.releases)).toHaveLength(1);
  });
});
