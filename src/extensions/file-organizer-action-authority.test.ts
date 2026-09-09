import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { createExtension } from "../db/queries/extensions";
import { listAuditLog } from "../db/queries/audit-log";
import { users, projects, projectMembers, extensions } from "../db/schema";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { buildFullGrantFromManifest } from "./install-grant";
import { createPermissionEngine, type AuthorizeContext } from "./permission-engine";
import { ExtensionRegistry } from "./registry";
import { configureReleaseRuntime } from "./release-process";
import type { CapabilitySet } from "./capability-types";
import {
  admitFileOrganizerEffect,
  admitFileOrganizerPrivateEffect,
  canonicalFileOrganizerPath,
  issueFileOrganizerActionAuthority,
  matchesFileOrganizerActionContext,
  type FileOrganizerActionAuthority,
  type FileOrganizerEffect,
} from "./file-organizer-action-authority";

mockDbConnection();
const roots: string[] = [];
beforeEach(async () => { await setupTestDb(); ExtensionRegistry.resetInstance(); });
afterEach(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(writePaths = ["watched/"], declaredHostWrite = false) {
  const db = getTestDb();
  const root = await mkdtemp(join(tmpdir(), "fo-pdp-")); roots.push(root);
  const projectRoot = join(root, "project");
  const dataRoot = join(root, "private", "file-organizer");
  const watched = join(projectRoot, "watched");
  await mkdir(watched, { recursive: true }); await mkdir(dataRoot, { recursive: true });
  const [owner] = await db.insert(users).values({ email: "fo-owner@example.test", passwordHash: "fixture", name: "Owner", role: "member", status: "active" }).returning();
  const [foreign] = await db.insert(users).values({ email: "fo-foreign@example.test", passwordHash: "fixture", name: "Foreign", role: "member", status: "active" }).returning();
  const [project] = await db.insert(projects).values({ name: "Owned files", path: projectRoot }).returning();
  await db.insert(projectMembers).values({ projectId: project!.id, userId: owner!.id, role: "member" });
  const manifest = validateManifest({ schemaVersion: 4, name: "file-organizer", version: "1.0.0", description: "PDP proof", author: { name: "Test" }, permissions: { filesystem: declaredHostWrite ? ["/data", watched] : ["/data"], network: ["example.test"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  const repository = new DatabaseLifecycleRepository(db);
  await repository.create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: runtime.snapshot.installation.id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  const binding = { id: crypto.randomUUID(), ownerId: owner!.id, projectId: project!.id, releaseId: runtime.snapshot.release.id, generation: 1, approvedAt: new Date().toISOString(), writePaths };
  const saveBinding = async () => { await db.execute(sql`INSERT INTO extension_project_bindings(installation_id,payload) VALUES(${runtime.snapshot.installation.id},${JSON.stringify(binding)}) ON CONFLICT (installation_id) DO UPDATE SET payload = EXCLUDED.payload`); };
  await saveBinding();
  configureReleaseRuntime({ runner: async () => runtime.runner, resolve: async id => { const state = await repository.read(id); return state?.installation.activeReleaseId ? { installation: state.installation, release: state.releases[state.installation.activeReleaseId]!, limits: runtime.snapshot.limits } : null; } });
  const registry = ExtensionRegistry.getInstance(); await registry.loadFromDb();
  const engine = createPermissionEngine({ registry, bus: new EventBus<AgentEvents>(), db });
  const effects: FileOrganizerEffect[] = ["one", "two"].map(id => ({ action: "file-organizer:confirm-deletes", subject: `${id}:1:delete-quarantine`, paths: [join(watched, id)], privatePath: `/data/.trash/${id}/file` }));
  const authority: FileOrganizerActionAuthority = { installationId: runtime.snapshot.installation.id, userId: owner!.id, releaseId: runtime.snapshot.release.id, generation: 1, bindingId: binding.id, projectId: project!.id, projectRoot, dataDirRoot: dataRoot, effects };
  const proof = issueFileOrganizerActionAuthority(authority);
  const authorize = (effect = effects[0]!, path = effect.paths[0]!, context: Partial<AuthorizeContext> = {}, needed?: CapabilitySet) => engine.authorize({ extensionId: authority.installationId, userId: owner!.id, conversationId: null, fileOrganizerActionAuthority: proof, fileOrganizerEffect: effect, ...context }, needed ?? [{ kind: "fs.write", value: path }]);
  return { db, root, projectRoot, dataRoot, watched, owner: owner!, foreign: foreign!, project: project!, runtime, repository, registry, binding, saveBinding, engine, effects, authority, proof, authorize };
}

test("real non-bundled grants require consent; each batch effect and private companion is admitted once and audited", async () => {
  const f = await fixture();
  expect(f.registry.isBundled(f.authority.installationId)).toBe(false);
  expect(f.registry.getGrantedPermissions(f.authority.installationId)?.filesystem).toEqual(["/data"]);
  expect((await f.engine.authorize({ extensionId: f.authority.installationId, userId: f.owner.id, conversationId: null }, [{ kind: "fs.write", value: f.effects[0]!.privatePath }])).decision).toBe("prompt");
  for (const effect of f.effects) {
    expect((await f.authorize(effect)).decision).toBe("allow");
    expect((await f.authorize(effect)).decision).toBe("deny");
    expect((await f.authorize(effect, effect.privatePath!)).decision).toBe("allow");
    expect((await f.authorize(effect, effect.privatePath!)).decision).not.toBe("allow");
  }
  const audit = await listAuditLog({ limit: 100 });
  expect(audit.filter(entry => entry.metadata?.reason === "file-organizer-project-binding")).toHaveLength(2);
  expect(audit.filter(entry => entry.metadata?.reason === "file-organizer-action-private-data")).toHaveLength(2);
});

test("copied proof, foreign actor/install, changed effect, cross-batch subject and mixed capabilities cannot authorize a host write", async () => {
  const f = await fixture(); const [first, second] = f.effects;
  for (const context of [
    { fileOrganizerActionAuthority: structuredClone(f.proof) },
    { userId: f.foreign.id },
    { extensionId: crypto.randomUUID() },
    { fileOrganizerEffect: { ...first!, subject: "altered" } },
    { fileOrganizerEffect: second! },
  ]) expect((await f.authorize(first, first!.paths[0], context)).decision).not.toBe("allow");
  expect((await f.authorize(first, join(f.root, "outside"))).decision).toBe("deny");
  for (const extra of [{ kind: "shell" as const }, { kind: "network" as const, value: "example.test" }]) {
    expect((await f.authorize(first, first!.paths[0], {}, [{ kind: "fs.write", value: first!.paths[0] }, extra])).decision).not.toBe("allow");
  }
  expect((await f.authorize(first)).decision).toBe("allow");
});

test("private writes require their exact prior public admission, actor, install, path, and a single capability", async () => {
  const f = await fixture(); const effect = f.effects[0]!;
  expect((await f.authorize(effect, effect.privatePath!)).decision).not.toBe("allow");
  expect((await f.authorize(effect)).decision).toBe("allow");
  for (const [path, context] of [
    ["/database/.trash/one/file", {}], ["/data/.trash/other/file", {}],
    [effect.privatePath!, { userId: f.foreign.id }], [effect.privatePath!, { extensionId: crypto.randomUUID() }],
    [effect.privatePath!, { fileOrganizerEffect: { ...effect, subject: "changed" } }],
  ] as const) expect((await f.authorize(effect, path, context)).decision).not.toBe("allow");
  expect((await f.authorize(effect, effect.privatePath!, {}, [{ kind: "fs.write", value: effect.privatePath }, { kind: "network", value: "example.test" }])).decision).not.toBe("allow");
  expect((await f.authorize(effect, effect.privatePath!)).decision).toBe("allow");
});

for (const change of ["binding", "membership", "user", "project-path", "generation", "disabled", "uninstalled", "write-scope", "release", "binding-owner", "binding-project", "binding-generation"] as const) {
  test(`private companion rechecks ${change} after public admission`, async () => {
    const f = await fixture(); const effect = f.effects[0]!;
    expect((await f.authorize(effect)).decision).toBe("allow");
    if (change === "binding") { f.binding.id = crypto.randomUUID(); await f.saveBinding(); }
    if (change === "membership") await f.db.delete(projectMembers).where(eq(projectMembers.projectId, f.project.id));
    if (change === "user") await f.db.update(users).set({ status: "inactive" }).where(eq(users.id, f.owner.id));
    if (change === "project-path") await f.db.update(projects).set({ path: f.root }).where(eq(projects.id, f.project.id));
    if (change === "generation") await f.repository.transact(f.authority.installationId, state => { state.installation.generation += 1; });
    if (change === "disabled") await f.repository.transact(f.authority.installationId, state => { state.installation.enabled = false; });
    if (change === "uninstalled") await f.repository.transact(f.authority.installationId, state => { state.installation.uninstalled = true; });
    if (change === "write-scope") { f.binding.writePaths = []; await f.saveBinding(); }
    if (change === "release") await f.repository.transact(f.authority.installationId, state => { state.installation.activeReleaseId = crypto.randomUUID(); });
    if (change === "binding-owner") { f.binding.ownerId = f.foreign.id; await f.saveBinding(); }
    if (change === "binding-project") { f.binding.projectId = crypto.randomUUID(); await f.saveBinding(); }
    if (change === "binding-generation") { f.binding.generation += 1; await f.saveBinding(); }
    expect((await f.authorize(effect, effect.privatePath!)).decision).not.toBe("allow");
  });
}

test("private consent never replaces the live /data grant", async () => {
  const f = await fixture(); const effect = f.effects[0]!;
  expect((await f.authorize(effect)).decision).toBe("allow");
  await f.db.update(extensions).set({ grantedPermissions: { ...buildFullGrantFromManifest(f.runtime.snapshot.release.manifest), filesystem: [] } }).where(eq(extensions.id, f.authority.installationId));
  expect((await f.authorize(effect, effect.privatePath!)).decision).toBe("deny");
});

test("prior always-allow consent cannot revive a revoked or consumed browser action", async () => {
  const f = await fixture(); const effect = f.effects[0]!;
  const ordinary = { extensionId: f.authority.installationId, userId: f.owner.id, conversationId: null };
  const needed: CapabilitySet = [{ kind: "fs.write", value: effect.privatePath }];
  const prompt = await f.engine.authorize(ordinary, needed);
  expect(prompt.decision).toBe("prompt");
  if (prompt.decision !== "prompt") throw new Error("Expected actual private-write consent prompt");
  await f.engine.resolvePrompt(prompt.promptId, true, "forever", "*");
  expect((await f.engine.authorize(ordinary, needed)).decision).toBe("allow");
  expect((await f.authorize(effect, effect.privatePath!, { fileOrganizerEffect: undefined })).decision).toBe("deny");
  expect((await f.authorize(effect, effect.privatePath!, { fileOrganizerActionAuthority: null })).decision).toBe("deny");
  expect((await f.authorize(effect)).decision).toBe("allow");
  expect((await f.authorize(effect, effect.privatePath!)).decision).toBe("allow");
  expect((await f.authorize(effect, effect.privatePath!)).decision).toBe("deny");
  const next = f.effects[1]!;
  expect((await f.authorize(next)).decision).toBe("allow");
  f.binding.writePaths = []; await f.saveBinding();
  expect((await f.authorize(next, next.privatePath!)).decision).toBe("deny");
});

test("simultaneous calls admit each exact public and private effect at most once", async () => {
  const f = await fixture(); const effect = f.effects[0]!;
  const publicResults = await Promise.all([f.authorize(effect), f.authorize(effect)]);
  expect(publicResults.filter(result => result.decision === "allow")).toHaveLength(1);
  const privateResults = await Promise.all([f.authorize(effect, effect.privatePath!), f.authorize(effect, effect.privatePath!)]);
  expect(privateResults.filter(result => result.decision === "allow")).toHaveLength(1);
});

test("an existing host filesystem grant does not bypass a browser action's finite effect", async () => {
  const f = await fixture(["watched/"], true); const effect = f.effects[0]!;
  expect((await f.authorize(effect)).decision).toBe("allow");
  expect((await f.authorize(effect)).decision).toBe("deny");
  f.binding.writePaths = []; await f.saveBinding();
  expect((await f.authorize(f.effects[1]!)).decision).toBe("deny");
});

test("an explicit private-only action needs no host write scope and cannot be redirected or replayed", async () => {
  const f = await fixture([]);
  const effect = { action: "file-organizer:purge", subject: "entry:1", paths: [], privatePath: "/data/.trash/entry" };
  const proof = issueFileOrganizerActionAuthority({ ...f.authority, effects: [effect] });
  expect((await f.authorize(effect, "/data/.trash/another", { fileOrganizerActionAuthority: proof })).decision).not.toBe("allow");
  expect((await f.authorize(effect, effect.privatePath, { fileOrganizerActionAuthority: proof })).decision).toBe("allow");
  expect((await f.authorize(effect, effect.privatePath, { fileOrganizerActionAuthority: proof })).decision).not.toBe("allow");
});

test("host scopes reject outside roots, sibling prefixes, private data and exact-file descendants", async () => {
  const f = await fixture(["watched/narrow"]);
  await mkdir(join(f.watched, "narrow"));
  for (const path of [join(f.watched, "narrow", "child"), join(f.projectRoot, "watched-other", "file"), join(f.root, "outside")]) {
    const effect = { ...f.effects[0]!, paths: [path] };
    const proof = issueFileOrganizerActionAuthority({ ...f.authority, effects: [effect] });
    expect((await f.authorize(effect, path, { fileOrganizerActionAuthority: proof })).decision).toBe("deny");
  }
  f.binding.writePaths = ["watched/"]; await f.saveBinding();
  const proof = issueFileOrganizerActionAuthority({ ...f.authority, dataDirRoot: f.watched });
  expect((await f.authorize(f.effects[0], f.effects[0]!.paths[0], { fileOrganizerActionAuthority: proof })).decision).toBe("deny");
});

test("a changed parent symlink cannot redirect a sealed host effect", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside"); await mkdir(outside);
  await rm(f.watched, { recursive: true }); await symlink(outside, f.watched);
  expect((await f.authorize()).decision).toBe("deny");
});

test("malformed or unbacked proof and invalid private paths fail closed", async () => {
  const f = await fixture(); const effect = f.effects[0]!;
  expect(matchesFileOrganizerActionContext(null, f.authority.installationId, [])).toBe(false);
  expect(await canonicalFileOrganizerPath(null as unknown as string)).toBeNull();
  expect(await admitFileOrganizerEffect(null, f.owner.id, effect)).toBe(false);
  expect(await admitFileOrganizerEffect(f.proof, null, effect)).toBe(false);
  expect(await admitFileOrganizerEffect(issueFileOrganizerActionAuthority({ ...f.authority, projectRoot: join(f.root, "missing") }), f.owner.id, effect)).toBe(false);
  for (const path of ["/database/entry", "/data/../outside"]) {
    const invalid = { action: "file-organizer:purge", subject: path, paths: [], privatePath: path };
    const proof = issueFileOrganizerActionAuthority({ ...f.authority, effects: [invalid] });
    expect(await admitFileOrganizerPrivateEffect(proof, f.owner.id, invalid, path)).toBe(false);
  }
  await writeFile(join(f.root, "file"), "leaf");
  expect(await canonicalFileOrganizerPath(join(f.root, "file", "child"))).toBe(join(f.root, "file", "child"));
});
