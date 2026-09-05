import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up } from "../../db/migrations/add-extension-project-authority";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { InstallationRecord, LifecycleActor } from "../v4/types";

const database = new PGlite();
const driver = drizzle(database);
await database.exec("CREATE TABLE extension_release_installations(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
await up(driver);
let active = true;
let member = true;
let local = true;
let owner = "user";
mock.module("../../db/connection", () => ({ getDb: () => driver }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ inspect: async () => ({ installation: { ownerId: owner } }) }) }));
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "user", status: active ? "active" : "disabled" }) }));
mock.module("../../db/queries/projects", () => ({ getProject: async () => ({ id: "project", path: local ? "/project" : null }) }));
mock.module("../../auth/middleware", () => ({ checkProjectRole: async () => member ? undefined : new Response(null, { status: 403 }) }));
const { getExtensionProjectBinding, setExtensionProjectBinding } = await import("../project-binding");
const actor: LifecycleActor = { kind: "human", principalId: "user", scope: "global" };
const input = { installationId: "installation", projectId: "project", releaseId: "release", generation: 1 };
const installation: InstallationRecord = { id: "installation", ownerId: "user", scope: "global", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 };
async function setInstallation(patch: Partial<InstallationRecord> = {}) { await database.query("INSERT INTO extension_release_installations(id,payload) VALUES('installation',$1) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [JSON.stringify({ ...installation, ...patch })]); }
beforeEach(async () => { active = member = local = true; owner = "user"; await database.exec("DELETE FROM extension_project_bindings"); await setInstallation(); });
afterAll(async () => { await database.close(); restoreModuleMocks(); });

test("human binds exact active release and revokes without child-writable storage", async () => {
  expect(await getExtensionProjectBinding("missing")).toBeNull();
  const binding = await setExtensionProjectBinding(actor, input);
  expect(binding).toMatchObject({ projectId: "project", ownerId: "user", releaseId: "release", generation: 1 });
  expect(await getExtensionProjectBinding("installation")).toEqual(binding);
  const replacement = await setExtensionProjectBinding(actor, { ...input, writePaths: ["docs/", "README.md", "docs/"] });
  expect(replacement?.id).not.toBe(binding?.id);
  expect(replacement?.writePaths).toEqual(["README.md", "docs/"]);
  expect(await setExtensionProjectBinding(actor, { ...input, projectId: null })).toBeNull();
  expect(await getExtensionProjectBinding("installation")).toBeNull();
});

test("binding requires human active owner membership local project and exact revision", async () => {
  await expect(setExtensionProjectBinding({ ...actor, kind: "agent" }, input)).rejects.toThrow("human session");
  await expect(setExtensionProjectBinding(actor, { ...input, generation: -1 })).rejects.toThrow("exact release");
  for (const path of ["../outside", "/absolute", "docs//", "docs/./file", "docs/*", "docs/\\bad", ""]) await expect(setExtensionProjectBinding(actor, { ...input, writePaths: [path] })).rejects.toThrow("safe relative");
  owner = "other"; await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("installation owner");
  owner = "user"; active = false; await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("active user");
  active = true; member = false; await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("membership");
  member = true; local = false; await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("local project");
  local = true; await expect(setExtensionProjectBinding(actor, { ...input, generation: 0 })).rejects.toThrow("active release changed");
  expect(await getExtensionProjectBinding("installation")).toBeNull();
});

test("disabled changed uninstalled or transferred releases immediately invalidate binding", async () => {
  await setExtensionProjectBinding(actor, input);
  for (const patch of [{ enabled: false }, { uninstalled: true }, { activeReleaseId: "new" }, { generation: 2 }, { ownerId: "other" }]) {
    await setInstallation(patch);
    expect(await getExtensionProjectBinding("installation")).toBeNull();
    await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("active release changed");
  }
});
