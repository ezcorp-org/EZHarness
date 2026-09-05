import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

let member = true;
let scope = "global";
let available = true;
let created: unknown[] = [];
mock.module("$server/auth/middleware", () => ({ requireSessionAuth: (locals: any) => locals.user ?? new Response("Denied", { status: 401 }), checkProjectRole: async () => member ? undefined : new Response("Denied", { status: 403 }) }));
mock.module("$lib/server/context", () => ({ ensureInitialized: async () => {} }));
mock.module("$server/db/queries/projects", () => ({ listProjects: async () => [{ id: "project", name: "Project" }, { id: "other", name: "Other" }], getProject: async (id: string) => id === "project" ? { id } : undefined }));
mock.module("$server/db/queries/conversations", () => ({ listRecentConversationsForUser: async () => [{ id: "owned", title: "Owned", projectId: "project" }, { id: "hidden", title: "Hidden", projectId: "outside" }], createConversation: async (...args: unknown[]) => { created.push(args); return { id: "created" }; } }));
mock.module("$lib/server/extension-browser", () => ({ authorizeExtensionBrowser: async () => { if (!available) throw new Error("private"); return { extension: { name: "browser" }, active: { installation: { scope }, release: { artifactDigest: "digest" } }, binding: "a".repeat(64) }; }, extensionBrowserBundle: async () => ({ spec: { tools: ["tool"] } }) }));
const { load, actions } = await import("../routes/(app)/extensions/[id]/preview/+page.server");
afterAll(() => restoreModuleMocks());
beforeEach(() => { member = true; scope = "global"; available = true; created = []; });

function event(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return { params: { id: "browser" }, locals: { user: { id: "owner" } }, url: new URL("https://app.example/extensions/browser/preview"), setHeaders: (values: Record<string, string>) => Object.assign(headers, values), headers, request: new Request("https://app.example/extensions/browser/preview?/create", { method: "POST", body: new URLSearchParams({ projectId: "project" }) }), ...overrides } as any;
}

test("selects only owned visible conversations and grants camera only to trusted host document", async () => {
  const input = event();
  const data: any = await load(input);
  expect(data.conversations).toEqual([{ id: "owned", title: "Owned", projectId: "project" }]);
  expect(data.conversationId).toBeNull();
  expect(data.nonce).toMatch(/^[a-f0-9-]{36}$/);
  expect(input.headers).toEqual({ "Cache-Control": "private, no-store", "Permissions-Policy": "camera=(self), microphone=(), geolocation=()" });
  scope = "project:project";
  expect((await load(event()) as any).projects).toEqual([{ id: "project", name: "Project" }]);
  member = false;
  expect((await load(event()) as any).conversations).toEqual([]);
  expect((await load(event()) as any).projects).toEqual([]);
  available = false;
  await expect(load(event())).rejects.toMatchObject({ status: 404 });
  await expect(load(event({ locals: {} }))).rejects.toMatchObject({ status: 403 });
});

test("creates conversations only through explicit authorized host action", async () => {
  await expect(actions!.create!(event())).rejects.toMatchObject({ status: 303, location: "/extensions/browser/preview?conversationId=created" });
  expect(created).toEqual([["project", { userId: "owner", title: "browser preview" }]]);
  scope = "project:other";
  await expect(actions!.create!(event())).rejects.toMatchObject({ status: 403 });
  member = false;
  await expect(actions!.create!(event())).rejects.toMatchObject({ status: 404 });
  await expect(actions!.create!(event({ locals: {} }))).rejects.toMatchObject({ status: 403 });
  expect(created).toHaveLength(1);
});
