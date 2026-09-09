import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../../../src/__tests__/helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../../../src/db/queries/extension-releases";
import { createExtension } from "../../../src/db/queries/extensions";
import { listAuditLog } from "../../../src/db/queries/audit-log";
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

async function fixture(options: { scope?: string; foreignActor?: boolean; writePaths?: string[]; quarantineCapGb?: number } = {}) {
  const database = getTestDb();
  _setPermissionEngineForTests(createPermissionEngine({ registry: ExtensionRegistry.getInstance(), bus: new EventBus<AgentEvents>(), db: database }));
  const [owner] = await database.insert(users).values({ email: "owner@example.test", passwordHash: "fixture", name: "Owner", role: "member", status: "active" }).returning();
  const folder = join(root, "watched");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const [project] = await database.insert(projects).values({ name: "Owned project", path: root }).returning();
  await database.insert(projectMembers).values({ projectId: project!.id, userId: owner!.id, role: "member" });
  const manifest = validateManifest({ schemaVersion: 4, name: "file-organizer", version: "1.0.0", description: "Host action proof", author: { name: "Test" }, pages: [{ id: "files", title: "Files" }], settings: { quarantine_ttl_days: { type: "number", label: "TTL", min: 1, max: 365, default: 30 }, quarantine_cap_gb: { type: "number", label: "Cap", min: 0, max: 1000, default: options.quarantineCapGb ?? 5 } }, permissions: { filesystem: ["/data"], eventSubscriptions: ["file-organizer:add-folder", "file-organizer:accept", "file-organizer:confirm-deletes", "file-organizer:restore", "file-organizer:purge", "file-organizer:empty-quarantine", "file-organizer:purge-expired"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  runtime.snapshot.installation.scope = options.scope ?? "global";
  const repository = new DatabaseLifecycleRepository(database);
  await repository.create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: runtime.snapshot.installation.id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.execute(sql`INSERT INTO extension_project_bindings(installation_id,payload) VALUES(${runtime.snapshot.installation.id},${JSON.stringify({ id: crypto.randomUUID(), ownerId: owner!.id, projectId: project!.id, releaseId: runtime.snapshot.release.id, generation: 1, approvedAt: new Date().toISOString(), writePaths: options.writePaths ?? [] })})`);
  configureReleaseRuntime({ runner: async () => runtime.runner, resolve: async id => { const state = await repository.read(id); return state?.installation.activeReleaseId ? { installation: state.installation, release: state.releases[state.installation.activeReleaseId]!, limits: runtime.snapshot.limits } : null; } });
  await ExtensionRegistry.getInstance().loadFromDb();
  expect(ExtensionRegistry.getInstance().isBundled(runtime.snapshot.installation.id)).toBe(false);
  expect(ExtensionRegistry.getInstance().getGrantedPermissions(runtime.snapshot.installation.id)?.filesystem).toEqual(["/data"]);
  for (const event of ["add-folder", "accept", "confirm-deletes", "restore", "purge", "empty-quarantine", "purge-expired"]) registerExtensionEvent("file-organizer", event);
  const actor = options.foreignActor ? (await database.insert(users).values({ email: "foreign@example.test", passwordHash: "fixture", name: "Foreign", role: "member", status: "active" }).returning())[0]! : owner!;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST({ ...makeRequestEvent(request.url, { params: { name: "file-organizer", event: new URL(request.url).pathname.split("/").at(-1)! }, locals: { user: actor } }), request }) });
  const post = (event = "add-folder", payload: Record<string, unknown> = { path: folder, projectId: project!.id }) => fetch(new URL(`/api/extensions/file-organizer/events/${event}`, server.url), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ source: "hub", pageId: "files", payload }) });
  const dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  return { database, repository, owner: owner!, project: project!, installationId: runtime.snapshot.installation.id, server, config: Bun.file(join(dataDir, "config.json")), dataDir, folder, post };
}

async function seedMove(data: Awaited<ReturnType<typeof fixture>>, collision = false) {
  const src = join(data.folder, "proof.tmp"); const dst = join(data.folder, "sorted", "proof.tmp");
  await writeFile(src, "host-bound-bytes");
  if (collision) { await mkdir(join(data.folder, "sorted"), { recursive: true }); await writeFile(dst, "existing-bytes"); }
  await mkdir(data.dataDir, { recursive: true });
  await writeFile(join(data.dataDir, "config.json"), JSON.stringify({ schemaVersion: 1, globalIgnore: [], folders: [{ id: "watched", path: data.folder, presets: [], customRules: [], ignore: [], backlogPolicy: "include-existing" }] }));
  await writeFile(join(data.dataDir, "proposals.json"), JSON.stringify({ schemaVersion: 1, suppressed: [], proposals: [{ id: "move-proof", version: 1, kind: "move", src, dst, folderId: "watched", reason: "test", ruleId: "test", ruleLabel: "test", status: "pending", dedupeKey: "test", createdAt: new Date().toISOString(), snapshot: { size: 16, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 } }] }));
  return { src, dst };
}

async function seedQuarantine(data: Awaited<ReturnType<typeof fixture>>, id = "quarantine-proof") {
  const name = `${id}.tmp`;
  const bytes = `${id}-bytes`;
  const src = join(data.folder, name);
  await writeFile(src, bytes);
  await mkdir(data.dataDir, { recursive: true });
  await writeFile(join(data.dataDir, "config.json"), JSON.stringify({ schemaVersion: 1, globalIgnore: [], folders: [{ id: "watched", path: data.folder, presets: [], customRules: [], ignore: [], backlogPolicy: "include-existing" }] }));
  await writeFile(join(data.dataDir, "proposals.json"), JSON.stringify({ schemaVersion: 1, suppressed: [], proposals: [{ id, version: 1, kind: "delete-quarantine", src, dst: null, quarantineId: id, folderId: "watched", reason: "test", ruleId: "test", ruleLabel: "test", status: "pending", dedupeKey: id, createdAt: new Date().toISOString(), snapshot: { size: Buffer.byteLength(bytes), mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 } }] }));
  return { id, src, bytes, trash: join(data.dataDir, ".trash", id, name) };
}

async function expectMissingDirectory(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function manifestIds(data: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  return ((await Bun.file(join(data.dataDir, ".trash", "manifest.json")).json()) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id);
}

test("human-approved project write scope permits the exact real move", async () => {
  const data = await fixture({ writePaths: ["watched/"] });
  try {
    const { src, dst } = await seedMove(data);
    const response = await data.post("accept", { proposalId: "move-proof" });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { ok: true, message: "Applied" } });
    expect(await Bun.file(src).exists()).toBe(false);
    expect(await Bun.file(dst).text()).toBe("host-bound-bytes");
    expect((await listAuditLog({ action: "ext:perm:allowed" })).some((entry) => {
      const metadata = entry.metadata as Record<string, unknown>;
      return metadata?.reason === "file-organizer-project-binding"
        && metadata.fileOrganizerAction === "file-organizer:accept"
        && metadata.fileOrganizerSubject === "move-proof:1:move"
        && JSON.stringify(metadata.fileOrganizerPaths) === JSON.stringify([src, dst]);
    })).toBe(true);
  } finally { await data.server.stop(true); }
});

test("an empty project write scope cannot move a watched proposal", async () => {
  const data = await fixture();
  try {
    const { src, dst } = await seedMove(data);
    const response = await data.post("accept", { proposalId: "move-proof" });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { ok: false, message: expect.stringContaining("Blocked:") } });
    expect(await Bun.file(src).text()).toBe("host-bound-bytes");
    expect(await Bun.file(dst).exists()).toBe(false);
  } finally { await data.server.stop(true); }
});

test.each(["watched/proof.tmp", "watched-sibling/"])("a non-directory or sibling write scope cannot widen to a move (%s)", async (writePath) => {
  const data = await fixture({ writePaths: [writePath] });
  try {
    const { src, dst } = await seedMove(data);
    expect(await (await data.post("accept", { proposalId: "move-proof" })).json()).toEqual({ ok: false, message: expect.stringContaining("Blocked:") });
    expect(await Bun.file(src).text()).toBe("host-bound-bytes");
    expect(await Bun.file(dst).exists()).toBe(false);
  } finally { await data.server.stop(true); }
});

test("a sealed directory-scope move preserves a collision and writes its planned suffix", async () => {
  const data = await fixture({ writePaths: ["watched/"] });
  try {
    const { src, dst } = await seedMove(data, true);
    const suffixed = dst.replace(".tmp", " (2).tmp");
    expect((await data.post("accept", { proposalId: "move-proof" })).status).toBe(200);
    expect(await Bun.file(src).exists()).toBe(false);
    expect(await Bun.file(dst).text()).toBe("existing-bytes");
    expect(await Bun.file(suffixed).text()).toBe("host-bound-bytes");
  } finally { await data.server.stop(true); }
});

test("a non-bundled V4 action quarantines through its private /data companion write", async () => {
  const data = await fixture({ writePaths: ["watched/"] });
  try {
    const { src, trash } = await seedQuarantine(data);
    const response = await data.post("accept", { proposalId: "quarantine-proof" });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { ok: true, message: "Applied" } });
    expect(await Bun.file(src).exists()).toBe(false);
    expect(await Bun.file(trash).text()).toBe("quarantine-proof-bytes");
    expect((await listAuditLog({ action: "ext:perm:allowed" })).some((entry) => {
      const metadata = entry.metadata as Record<string, unknown>;
      return metadata.reason === "file-organizer-action-private-data"
        && metadata.fileOrganizerAction === "file-organizer:accept"
        && metadata.fileOrganizerSubject === "quarantine-proof:1:delete-quarantine";
    })).toBe(true);
  } finally { await data.server.stop(true); }
});

test("one confirmed batch uses separate sealed quarantine effects and can restore both files", async () => {
  const data = await fixture({ writePaths: ["watched/"] });
  try {
    const first = await seedQuarantine(data, "batch-first");
    const second = await seedQuarantine(data, "batch-second");
    const proposal = (entry: typeof first) => ({ id: entry.id, version: 1, kind: "delete-quarantine", src: entry.src, dst: null, quarantineId: entry.id, folderId: "watched", reason: "test", ruleId: "test", ruleLabel: "test", status: "pending", dedupeKey: entry.id, createdAt: new Date().toISOString(), snapshot: { size: Buffer.byteLength(entry.bytes), mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 } });
    await writeFile(join(data.dataDir, "proposals.json"), JSON.stringify({ schemaVersion: 1, suppressed: [], proposals: [proposal(first), proposal(second)] }));
    expect(await (await data.post("confirm-deletes", {})).json()).toEqual({ ok: true, message: "Quarantined 2" });
    expect(await Bun.file(first.src).exists()).toBe(false);
    expect(await Bun.file(second.src).exists()).toBe(false);
    expect(await (await data.post("restore", { all: true })).json()).toEqual({ ok: true, message: "Restored 2" });
    expect(await Bun.file(first.src).text()).toBe(first.bytes);
    expect(await Bun.file(second.src).text()).toBe(second.bytes);
  } finally { await data.server.stop(true); }
});

test("a sealed restore plans its collision suffix and an explicit private purge is auditable", async () => {
  const data = await fixture({ writePaths: ["watched/"] });
  try {
    const entry = await seedQuarantine(data, "restore-proof");
    expect(await (await data.post("accept", { proposalId: entry.id })).json()).toEqual({ ok: true, message: "Applied" });
    await writeFile(entry.src, "keep-original");
    expect(await (await data.post("restore", { quarantineId: entry.id })).json()).toEqual({ ok: true, message: "Restored 1" });
    const restored = entry.src.replace(".tmp", " (2).tmp");
    expect(await Bun.file(entry.src).text()).toBe("keep-original");
    expect(await Bun.file(restored).text()).toBe(entry.bytes);
    await writeFile(join(data.folder, "purge-source.tmp"), "purge-bytes");
    await writeFile(join(data.dataDir, "proposals.json"), JSON.stringify({ schemaVersion: 1, suppressed: [], proposals: [{ id: "purge-proof", version: 1, kind: "delete-quarantine", src: join(data.folder, "purge-source.tmp"), dst: null, quarantineId: "purge-proof", folderId: "watched", reason: "test", ruleId: "test", ruleLabel: "test", status: "pending", dedupeKey: "purge-proof", createdAt: new Date().toISOString(), snapshot: { size: 11, mtimeMs: 0, isSymlink: false, dev: 0, ino: 0, nlink: 1 } }] }));
    expect(await (await data.post("accept", { proposalId: "purge-proof" })).json()).toEqual({ ok: true, message: "Applied" });
    expect(await (await data.post("purge", { quarantineId: "purge-proof" })).json()).toEqual({ ok: true, message: "Deleted permanently" });
    await expectMissingDirectory(join(data.dataDir, ".trash", "purge-proof"));
    expect(await manifestIds(data)).not.toContain("purge-proof");
    const purgeAudits = await listAuditLog({ action: "ext:perm:allowed" });
    expect(purgeAudits.some((entry) => {
      const metadata = entry.metadata as Record<string, unknown>;
      return metadata.reason === "file-organizer-action-private-data"
        && metadata.fileOrganizerAction === "file-organizer:purge"
        && typeof metadata.fileOrganizerSubject === "string"
        && metadata.fileOrganizerSubject.startsWith("quarantine:purge-proof:");
    })).toBe(true);
    const empty = await seedQuarantine(data, "empty-proof");
    expect(await (await data.post("accept", { proposalId: empty.id })).json()).toEqual({ ok: true, message: "Applied" });
    expect(await (await data.post("empty-quarantine", {})).json()).toEqual({ ok: true, message: "Quarantine emptied 1" });
    await expectMissingDirectory(join(data.dataDir, ".trash", empty.id));
    expect(await manifestIds(data)).not.toContain(empty.id);
  } finally { await data.server.stop(true); }
});

test("a cap-based purge-expired action seals and removes every selected private entry", async () => {
  const data = await fixture({ writePaths: ["watched/"], quarantineCapGb: 0.000000001 });
  try {
    const first = await seedQuarantine(data, "cap-first");
    expect(await (await data.post("accept", { proposalId: first.id })).json()).toEqual({ ok: true, message: "Applied" });
    const second = await seedQuarantine(data, "cap-second");
    expect(await (await data.post("accept", { proposalId: second.id })).json()).toEqual({ ok: true, message: "Applied" });
    expect(await (await data.post("purge-expired", {})).json()).toEqual({ ok: true, message: "Purged 2" });
    await expectMissingDirectory(join(data.dataDir, ".trash", first.id));
    await expectMissingDirectory(join(data.dataDir, ".trash", second.id));
    expect(await manifestIds(data)).toEqual([]);
  } finally { await data.server.stop(true); }
});

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
