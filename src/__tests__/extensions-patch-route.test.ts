import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
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
const read = async (id: string) => missing ? null : { id, name: "fixture", enabled, manifest };
const queries = () => ({ getExtensionByRef: read, getExtension: read, updateExtension: directWrites, deleteExtension: directWrites, resetFailures: directWrites });
mock.module("../db/queries/extensions", queries);
mock.module("$server/db/queries/extensions", queries);
const lifecycle = {
  async inspect() { if (missing || legacy) throw new LifecycleError("not_found", "Installation not found"); },
  async disable(actor: LifecycleActor, id: string) { if (mutationFailure) throw new LifecycleError("generation_superseded", "A newer generation exists"); mutations.push({ action: "disable", actor, id }); enabled = false; },
  async uninstall(actor: LifecycleActor, id: string) { mutations.push({ action: "uninstall", actor, id }); },
};
const services = () => ({ getExtensionLifecycle: async () => lifecycle });
mock.module("../extensions/extension-lifecycle-service", services);
mock.module("$server/extensions/extension-lifecycle-service", services);
const registry = () => ({ ExtensionRegistry: { getInstance: () => ({ reload, killAll: reload }) } });
mock.module("../extensions/registry", registry);
mock.module("$server/extensions/registry", registry);
const scopes = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", scopes);
mock.module("../../web/src/lib/server/security/api-keys", scopes);
const { GET, PATCH, DELETE } = await import("../../web/src/routes/api/extensions/[id]/+server");

async function request(method: "GET" | "PATCH" | "DELETE", options: { body?: unknown; user?: typeof ADMIN_USER | typeof MEMBER_USER | null; session?: boolean } = {}) {
  const event = createMockEvent({ method, url: "http://localhost/api/extensions/installation", params: { id: "installation" }, body: options.body, user: options.user === null ? undefined : options.user ?? ADMIN_USER });
  if (options.session) event.locals.authMethod = "session";
  try { return await ({ GET, PATCH, DELETE }[method])(event as never); }
  catch (error) { if (error instanceof Response) return error; throw error; }
}

beforeEach(() => { missing = legacy = mutationFailure = false; enabled = true; manifest = { schemaVersion: 4, name: "fixture" }; mutations.length = 0; directWrites.mockClear(); reload.mockClear(); });
afterAll(() => restoreModuleMocks());

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
