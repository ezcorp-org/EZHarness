import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../../../src/__tests__/helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../../../src/db/queries/extension-releases";
import { createExtension } from "../../../src/db/queries/extensions";
import { buildFullGrantFromManifest } from "../../../src/extensions/install-grant";
import { configureReleaseRuntime } from "../../../src/extensions/release-process";
import { users, projects, projectMembers, extensions } from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import { registerExtensionEvent } from "../../../src/runtime/sse-conversation-filter";
import { EventBus } from "../../../src/runtime/events";
import type { AgentEvents } from "../../../src/types";
import { makeRequestEvent } from "./helpers/server-route-test-utils";
import * as bundled from "../../../src/extensions/bundled";
import { createPermissionEngine, _setPermissionEngineForTests } from "../../../src/extensions/permission-engine";
import { ExtensionRegistry } from "../../../src/extensions/registry";

mockDbConnection();
mock.module("$lib/server/context", () => ({ getBus: () => new EventBus<AgentEvents>(), getExecutor: () => ({}) }));
const { POST, __hubActionRateLimiter } = await import("../routes/api/extensions/[name]/events/[event]/+server");
let root: string;
let rootPath: ReturnType<typeof spyOn>;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "file-organizer-authority-")); rootPath = spyOn(bundled, "getProjectRoot").mockImplementation(() => root); });
beforeEach(async () => { await setupTestDb(); await rm(join(root, ".ezcorp"), { recursive: true, force: true }); __hubActionRateLimiter.reset(); });
afterAll(async () => { rootPath.mockRestore(); await closeTestDb(); await rm(root, { recursive: true, force: true }); });

async function fixture(options: { scope?: string; foreignActor?: boolean } = {}) {
  const database = getTestDb();
  _setPermissionEngineForTests(createPermissionEngine({ registry: ExtensionRegistry.getInstance(), bus: new EventBus<AgentEvents>(), db: database }));
  const [owner] = await database.insert(users).values({ email: "owner@example.test", passwordHash: "fixture", name: "Owner", role: "member", status: "active" }).returning();
  const folder = join(root, "watched");
  await mkdir(folder, { recursive: true });
  const [project] = await database.insert(projects).values({ name: "Owned project", path: root }).returning();
  await database.insert(projectMembers).values({ projectId: project!.id, userId: owner!.id, role: "member" });
  const manifest = validateManifest({ schemaVersion: 4, name: "file-organizer", version: "1.0.0", description: "Host action proof", author: { name: "Test" }, pages: [{ id: "files", title: "Files" }], permissions: { eventSubscriptions: ["file-organizer:add-folder"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  runtime.snapshot.installation.scope = options.scope ?? "global";
  const repository = new DatabaseLifecycleRepository(database);
  await repository.create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: runtime.snapshot.installation.id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.execute(sql`INSERT INTO extension_project_bindings(installation_id,payload) VALUES(${runtime.snapshot.installation.id},${JSON.stringify({ id: crypto.randomUUID(), ownerId: owner!.id, projectId: project!.id, releaseId: runtime.snapshot.release.id, generation: 1, approvedAt: new Date().toISOString(), writePaths: [] })})`);
  configureReleaseRuntime({ runner: async () => runtime.runner, resolve: async id => { const state = await repository.read(id); return state?.installation.activeReleaseId ? { installation: state.installation, release: state.releases[state.installation.activeReleaseId]!, limits: runtime.snapshot.limits } : null; } });
  registerExtensionEvent("file-organizer", "add-folder");
  const actor = options.foreignActor ? (await database.insert(users).values({ email: "foreign@example.test", passwordHash: "fixture", name: "Foreign", role: "member", status: "active" }).returning())[0]! : owner!;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST({ ...makeRequestEvent(request.url, { params: { name: "file-organizer", event: "add-folder" }, locals: { user: actor } }), request }) });
  return { database, repository, owner: owner!, project: project!, installationId: runtime.snapshot.installation.id, server, config: Bun.file(join(root, ".ezcorp/extension-data/file-organizer/config.json")), post: () => fetch(new URL("/api/extensions/file-organizer/events/add-folder", server.url), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ source: "hub", pageId: "files", payload: { path: folder, projectId: project!.id } }) }) };
}

test("revoked project membership cannot mutate the host configuration through the Hub shortcut", async () => {
  const data = await fixture();
  try {
    await data.database.execute(sql`DELETE FROM project_members WHERE user_id=${data.owner.id} AND project_id=${data.project.id}`);
    const response = await data.post();
    expect({ status: response.status, wroteConfiguration: await data.config.exists() }).toEqual({ status: 404, wroteConfiguration: false });
  } finally { await data.server.stop(true); }
});

test("revoked release project binding cannot be replaced by caller payload", async () => {
  const data = await fixture();
  try {
    await data.database.execute(sql`DELETE FROM extension_project_bindings WHERE installation_id=${data.installationId}`);
    expect({ status: (await data.post()).status, wroteConfiguration: await data.config.exists() }).toEqual({ status: 404, wroteConfiguration: false });
  } finally { await data.server.stop(true); }
});

test("exact active owner and project binding still permit the real host action", async () => {
  const data = await fixture();
  try {
    expect((await data.post()).status).toBe(200);
    expect(await data.config.exists()).toBe(true);
    expect((await data.config.json()).folders).toHaveLength(1);
  } finally { await data.server.stop(true); }
});

test.each(["disabled", "sealed-grant", "current-grant", "inactive-user", "foreign-owner", "wrong-project"] as const)("%s authority refuses the real host action", async (revocation) => {
  const data = await fixture({ ...(revocation === "wrong-project" ? { scope: "project:another-project" } : {}), foreignActor: revocation === "foreign-owner" });
  try {
    if (revocation === "current-grant") await data.database.update(extensions).set({ grantedPermissions: { grantedAt: {} } }).where(eq(extensions.id, data.installationId));
    else if (revocation === "inactive-user") await data.database.execute(sql`UPDATE users SET status='disabled' WHERE id=${data.owner.id}`);
    else await data.repository.transact(data.installationId, state => {
      if (revocation === "disabled") state.installation.enabled = false;
      if (revocation === "sealed-grant") state.installation.grants = [];
    });
    expect({ status: (await data.post()).status, wroteConfiguration: await data.config.exists() }).toEqual({ status: 404, wroteConfiguration: false });
  } finally { await data.server.stop(true); }
});
