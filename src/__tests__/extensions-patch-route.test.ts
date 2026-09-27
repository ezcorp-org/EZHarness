import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks, webLibModule, serverModule } from "./helpers/mock-cleanup";
import { ExtensionRegistry } from "../extensions/registry";
import { ADMIN_USER, MEMBER_USER, createMockEvent, mockServerAlias } from "./helpers/mock-request";
import { LifecycleError, type LifecycleActor } from "../extensions/v4/types";

mockServerAlias();
let missing = false;
let legacy = false;
let enabled = true;
let manifest: Record<string, unknown> = { schemaVersion: 4, name: "fixture" };
let mutationFailure = false;
const mutations: { action: string; actor: LifecycleActor; id: string }[] = [];
const directWrites = mock(() => { throw new Error("Route bypassed release lifecycle"); });
const reload = mock(() => { throw new Error("Route bypassed fenced publication"); });
// `$server/db/queries/extensions` cannot be withdrawn once registered, and
// OTHER files also claim it, so a relative-only mock cannot be relied on
// here the way it can for lifecycle-service/registry below. Claim it, then
// hand it BACK to the real module in afterAll (W18c's diff, cited in the
// gates file) — without that, a later route (phase-2b-e2e.test.ts) reads
// THIS file's fixture row, which has no grantedPermissions, and returns an
// empty body. Scoped to this test's own fixture id ("installation") on top
// of that, falling through to the real, DB-backed function for any other
// id, so installer-idempotent-local.test.ts's own real ids still read real
// rows in the window before afterAll runs.
const realExtensionQueries = serverModule("db/queries/extensions", {}) as {
  getExtensionByRef: (id: string) => unknown;
  updateExtension: (id: string, data: Record<string, unknown>) => unknown;
  deleteExtension: (id: string) => unknown;
  resetFailures: (id: string) => unknown;
};
const FIXTURE_ID = "installation";
const read = async (id: string) => id !== FIXTURE_ID ? realExtensionQueries.getExtensionByRef(id) : missing ? null : { id, name: "fixture", enabled, manifest };
const queries = serverModule("db/queries/extensions", {
  getExtensionByRef: read,
  getExtension: read,
  updateExtension: (id: string, data: Record<string, unknown>) => id !== FIXTURE_ID ? realExtensionQueries.updateExtension(id, data) : directWrites(),
  deleteExtension: (id: string) => id !== FIXTURE_ID ? realExtensionQueries.deleteExtension(id) : directWrites(),
  resetFailures: (id: string) => id !== FIXTURE_ID ? realExtensionQueries.resetFailures(id) : directWrites(),
});
mock.module("../db/queries/extensions", () => queries);
mock.module("$server/db/queries/extensions", () => queries);
const lifecycle = {
  async inspect() { if (missing || legacy) throw new LifecycleError("not_found", "Installation not found"); },
  async disable(actor: LifecycleActor, id: string) { if (mutationFailure) throw new LifecycleError("generation_superseded", "A newer generation exists"); mutations.push({ action: "disable", actor, id }); enabled = false; },
  async uninstall(actor: LifecycleActor, id: string) { mutations.push({ action: "uninstall", actor, id }); },
};
// The lifecycle service is mocked on its RELATIVE path ONLY — no
// `$server/extensions/extension-lifecycle-service` registration at all. A
// route resolves that alias natively to the same record as the relative
// path when nothing has claimed the alias separately, so the stub still
// reaches it; but an alias registration can never be withdrawn, and once
// one exists, installer-idempotent-local.test.ts's own spyOn() on the real
// lifecycle-service namespace no longer reaches its author loader (3
// failures; W18c's diff, cited in the gates file). Spread the real module
// under the fake so no export name is ever missing.
const realLifecycleService = serverModule("extensions/extension-lifecycle-service", {});
const lifecycleModule = () => ({ ...realLifecycleService, getExtensionLifecycle: async () => lifecycle });
mock.module("../extensions/extension-lifecycle-service", lifecycleModule);
const scopes = webLibModule("server/security/api-keys", { requireScope: () => null });
mock.module("$lib/server/security/api-keys", () => scopes);
mock.module("../../web/src/lib/server/security/api-keys", () => scopes);
const { GET, PATCH, DELETE } = await import("../../web/src/routes/api/extensions/[id]/+server");

async function request(method: "GET" | "PATCH" | "DELETE", options: { body?: unknown; user?: typeof ADMIN_USER | typeof MEMBER_USER | null; session?: boolean } = {}) {
  const event = createMockEvent({ method, url: "http://localhost/api/extensions/installation", params: { id: "installation" }, body: options.body, user: options.user === null ? undefined : options.user ?? ADMIN_USER });
  if (options.session) event.locals.authMethod = "session";
  try { return await ({ GET, PATCH, DELETE }[method])(event as never); }
  catch (error) { if (error instanceof Response) return error; throw error; }
}

// ExtensionRegistry.getInstance() is a cheap in-memory singleton (no I/O) —
// never replace the class/module: any OTHER file's already-loaded consumer
// (scoped-tools.ts, context.ts, …) shares the SAME singleton object either
// way, and a module-level mock.module() override freezes on whichever file
// bound it first for the rest of the process, breaking every other
// consumer's real methods (tool scoping, workflow loading, …). spyOn() the
// real instance's two methods instead; restoreModuleMocks()'s mock.restore()
// undoes it for everyone, from wherever they got their reference.
//
// Fetched in beforeAll, NOT at this file's own top level: every file that
// does this same thing calls ExtensionRegistry.getInstance() during the
// SHARED LOADING PHASE (before any file's tests run), when the singleton has
// not been reset by anyone yet — so two such files capture the SAME
// instance. The first file's own afterAll then calls resetInstance(),
// discarding it; the second file's module-level reference is now stale, and
// its OWN spies point at an object getInstance() no longer returns —
// leaving its OWN afterAll's assertions silently checking nothing, and a
// LATER real caller (phase-2b-e2e.test.ts's publish(), reaching a fresh
// instance this file never spied) hitting whichever spy is STILL active
// from whoever spied last. Fetching it in beforeAll (test-execution time,
// after every earlier file's own resetInstance() has already run) gets the
// instance actually live for THIS file's own run.
let registryInstance: ExtensionRegistry;
let reloadSpy: ReturnType<typeof spyOn>;
let killAllSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  registryInstance = ExtensionRegistry.getInstance();
  reloadSpy = spyOn(registryInstance, "reload").mockImplementation(async () => { reload(); });
  killAllSpy = spyOn(registryInstance, "killAll").mockImplementation(() => { reload(); });
});

beforeEach(() => { missing = legacy = mutationFailure = false; enabled = true; manifest = { schemaVersion: 4, name: "fixture" }; mutations.length = 0; directWrites.mockClear(); reload.mockClear(); });
afterAll(() => {
  // Hand the claimed extensions-queries alias back to the real module
  // before the generic restore, which cannot reach a `$server/*` alias (see
  // the comment above). The lifecycle-service alias was never claimed, so
  // there is nothing to hand back for it — only its relative path, which
  // restoreModuleMocks() already covers via MODULE_PATHS.
  mock.module("$server/db/queries/extensions", () => realExtensionQueries);
  restoreModuleMocks();
  // Un-spy BEFORE resetInstance(): resetInstance() calls the instance's own
  // killAll(), and leaving the throwing spy in place would make resetInstance()
  // itself throw, skip `instance = null`, and leave the spied instance in
  // place for every later file to inherit.
  reloadSpy.mockRestore();
  killAllSpy.mockRestore();
  ExtensionRegistry.resetInstance();
});

describe("extension release route delegation", () => {
  test("disable delegates exact identity and returns the disabled projection", async () => {
    const response = await request("PATCH", { body: { enabled: false }, session: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "installation", enabled: false });
    expect(mutations).toEqual([{ action: "disable", id: "installation", actor: { principalId: ADMIN_USER.id, scope: "global", kind: "human" } }]);
    expect(directWrites).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("uninstall delegates once without deleting projection, data or unrelated processes", async () => {
    expect((await request("DELETE")).status).toBe(204);
    expect(mutations).toEqual([{ action: "uninstall", id: "installation", actor: { principalId: ADMIN_USER.id, scope: "global", kind: "agent" } }]);
    expect(directWrites).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("generation conflicts cannot produce a success response", async () => {
    mutationFailure = true;
    const response = await request("PATCH", { body: { enabled: false } });
    expect(response.status).toBe(409);
    expect(enabled).toBe(true);
    expect(mutations).toHaveLength(0);
  });

  test("legacy enable and malformed inputs never mutate installation authority", async () => {
    for (const body of [{ enabled: true }, { enabled: "yes" }, { enabled: 0 }]) expect((await request("PATCH", { body })).status).toBe(410);
    for (const body of [{ other: true }, null, []]) expect((await request("PATCH", { body })).status).toBe(400);
    expect(mutations).toHaveLength(0);
  });

  test("missing and legacy installations cannot bypass lifecycle inspection", async () => {
    missing = true;
    for (const method of ["GET", "PATCH", "DELETE"] as const) expect((await request(method, { body: { enabled: false } })).status).toBe(404);
    missing = false; legacy = true;
    for (const method of ["PATCH", "DELETE"] as const) expect((await request(method, { body: { enabled: false } })).status).toBe(410);
    expect(mutations).toHaveLength(0);
  });

  test("mutations require an administrator while reads permit a member", async () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      expect((await request(method, { body: { enabled: false }, user: null })).status).toBe(401);
      expect((await request(method, { body: { enabled: false }, user: MEMBER_USER })).status).toBe(403);
    }
    expect((await request("GET", { user: MEMBER_USER })).status).toBe(200);
    expect(mutations).toHaveLength(0);
  });
});

test("single-row reads scrub MCP query, header and argv credentials", async () => {
  manifest = { kind: "mcp", name: "fixture", tools: [], permissions: {}, mcpServers: [
    { transport: "http", name: "remote", url: "https://mcp.example.com/mcp?api_key=URL-LEAK", headers: { Authorization: "Bearer HDR-LEAK" } },
    { transport: "stdio", name: "local", command: "npx", args: ["-y", "server", "--token=ARGV-LEAK"] },
  ] };
  const response = await request("GET", { user: MEMBER_USER });
  expect(response.status).toBe(200);
  const body = await response.text();
  for (const value of ["URL-LEAK", "HDR-LEAK", "ARGV-LEAK"]) expect(body).not.toContain(value);
  for (const value of ["api_key=", "--token=", "Authorization"]) expect(body).toContain(value);
});

test("read returns a redacted ordinary v4 projection without lifecycle mutation", async () => {
  const response = await request("GET", { user: ADMIN_USER });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: "installation", name: "fixture", enabled: true });
  expect(mutations).toHaveLength(0);
  expect(directWrites).not.toHaveBeenCalled();
});

test("purging data through uninstall is rejected before lifecycle mutation", async () => {
  const event = createMockEvent({ method: "DELETE", url: "http://localhost/api/extensions/installation?purgeData=1", params: { id: "installation" }, user: ADMIN_USER });
  const response = await DELETE(event as never);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("preserves data") });
  expect(mutations).toHaveLength(0);
});

test("a browser session marks an uninstall as a human lifecycle action", async () => {
  const response = await request("DELETE", { session: true });
  expect(response.status).toBe(204);
  expect(mutations[0]?.actor.kind).toBe("human");
  expect(directWrites).not.toHaveBeenCalled();
});

test("an API-key uninstall remains an agent lifecycle action", async () => {
  const response = await request("DELETE");
  expect(response.status).toBe(204);
  expect(mutations[0]?.actor.kind).toBe("agent");
  expect(reload).not.toHaveBeenCalled();
});
