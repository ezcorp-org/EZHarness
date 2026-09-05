import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

let user: any;
let extension: any;
let active: any;
let conversation: any;
let membership: boolean;
let allowed: boolean;
let files: Record<string, string>;
let reads = 0;
mock.module("$server/db/queries/users", () => ({ getUserById: async () => user }));
mock.module("$server/db/queries/extensions", () => ({ getExtensionByName: async () => extension }));
mock.module("$server/db/queries/conversations", () => ({ getConversation: async () => conversation }));
mock.module("$server/db/queries/project-members", () => ({ getProjectMembership: async () => membership }));
mock.module("$server/auth/extension-wire-authz", () => ({ canWireExtension: async () => allowed }));
mock.module("$server/extensions/release-process", () => ({
  getReleaseRuntime: () => ({ runner: async () => ({ collectArtifacts: async () => { reads++; return files; } }) }),
  resolveActiveRelease: async () => active,
  releaseBinding: (value: unknown) => canonicalJson(value),
}));
const { authorizeExtensionBrowser, extensionBrowserBundle } = await import("../lib/server/extension-browser");
afterAll(() => restoreModuleMocks());
beforeEach(() => {
  user = { id: "owner", role: "user", status: "active" };
  extension = { id: "extension", name: "browser", enabled: true };
  active = { installation: { scope: "global", generation: 1 }, release: { id: "release" } };
  conversation = { id: "conversation", userId: "owner", projectId: "project" };
  membership = true;
  allowed = true;
});

test("checks principal, owned conversation, scope, membership and live grants before binding", async () => {
  const authority = await authorizeExtensionBrowser("browser", "owner", "conversation");
  expect(authority.binding).toMatch(/^[a-f0-9]{64}$/);
  expect((await authorizeExtensionBrowser("browser", "owner", "conversation", authority.binding)).binding).toBe(authority.binding);
  active.installation.generation++;
  await expect(authorizeExtensionBrowser("browser", "owner", "conversation", authority.binding)).rejects.toThrow("changed");
  user.status = "inactive";
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("unavailable");
  user.status = "active";
  extension.enabled = false;
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("unavailable");
  extension.enabled = true;
  conversation.userId = "other";
  await expect(authorizeExtensionBrowser("browser", "owner", "conversation")).rejects.toThrow("owned");
  conversation = null;
  await expect(authorizeExtensionBrowser("browser", "owner", "conversation")).rejects.toThrow("owned");
  active.installation.scope = "unknown";
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("scope");
  active.installation.scope = "project:";
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("scope");
  active.installation.scope = "project:project";
  conversation = { userId: "owner", projectId: "different" };
  await expect(authorizeExtensionBrowser("browser", "owner", "conversation")).rejects.toThrow("extension project");
  membership = false;
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("membership");
  user.role = "admin";
  expect((await authorizeExtensionBrowser("browser", "owner")).user.id).toBe("owner");
  allowed = false;
  await expect(authorizeExtensionBrowser("browser", "owner")).rejects.toThrow("unavailable");
});

function bundle(index: number): Record<string, string> {
  const spec = { schemaVersion: 1, entrypoint: "app.js", html: "index.html", styles: [], tools: ["probe"] };
  return { "ezcorp.browser.json": JSON.stringify(spec), "app.js": "document.title='probe'", "index.html": "<body></body>", ".runner/browser.json": canonicalJson(spec), ".runner/browser.html": `<body>${index}</body>` };
}

test("verifies immutable bundle digests and bounds retained cache entries", async () => {
  files = bundle(1);
  const digest = filesDigest(files);
  const first = await extensionBrowserBundle(digest);
  expect(first.html).toBe("<body>1</body>");
  const baseline = reads;
  expect(await extensionBrowserBundle(digest)).toBe(first);
  expect(reads).toBe(baseline);
  for (let index = 2; index <= 9; index++) { files = bundle(index); await extensionBrowserBundle(filesDigest(files)); }
  files = bundle(1);
  expect(await extensionBrowserBundle(digest)).not.toBe(first);
  await expect(extensionBrowserBundle("f".repeat(64))).rejects.toThrow("digest mismatch");
  files = { "index.html": "none" };
  await expect(extensionBrowserBundle(filesDigest(files))).rejects.toThrow("no verified");
  files = bundle(10);
  files[".runner/browser.json"] = "{}";
  await expect(extensionBrowserBundle(filesDigest(files))).rejects.toThrow("no verified");
  files = bundle(11);
  files[".runner/browser.html"] = "x".repeat(12 * 1024 ** 2 + 1);
  await expect(extensionBrowserBundle(filesDigest(files))).rejects.toThrow("exceeds");
});
