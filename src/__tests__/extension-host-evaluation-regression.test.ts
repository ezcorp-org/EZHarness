import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "./helpers/mock-request";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
mockDbConnection();
mockServerAlias();
mock.module("$server/extensions/author-install", () => require("../extensions/author-install"));
mock.module("$server/extensions/sdk/verify", () => require("../extensions/sdk/verify"));
mock.module("$server/extensions/author-gate", () => require("../extensions/author-gate"));
mock.module("$server/db/queries/ez-drafts", () => require("../db/queries/ez-drafts"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/extensions/legacy-endpoint", () => require("../../web/src/lib/server/extensions/legacy-endpoint"));
const { POST: install } = await import("../../web/src/routes/api/extensions/author/install/+server");
const { POST: validate } = await import("../../web/src/routes/api/extensions/author/draft/[id]/validate/+server");
const { createDraft, getExtensionAuthorDraftDir } = await import("../db/queries/ez-drafts");
const { handleDraftsRpc } = await import("../extensions/drafts-handler");
const { loadManifest, loadManifestFresh } = await import("../extensions/loader");
const { createUser } = await import("../db/queries/users");
const { __resetProjectRootCacheForTests } = await import("../extensions/project-root");
let root: string;
const priorRoot = process.env.EZCORP_PROJECT_ROOT;
beforeAll(async () => {
  await setupTestDb();
  await createUser({ id: ADMIN_USER.id, name: ADMIN_USER.name, email: ADMIN_USER.email, passwordHash: "hash", role: "admin", status: "active" });
  root = await mkdtemp(join(tmpdir(), "extension-host-evaluation-"));
  await mkdir(join(root, "docs/extensions/examples"), { recursive: true });
  process.env.EZCORP_PROJECT_ROOT = root;
  __resetProjectRootCacheForTests();
});
afterAll(async () => {
  if (priorRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT; else process.env.EZCORP_PROJECT_ROOT = priorRoot;
  __resetProjectRootCacheForTests();
  if (root) await rm(root, { recursive: true, force: true });
  await closeTestDb();
  restoreModuleMocks();
});

async function hostileDraft() {
  const draft = await createDraft({ userId: ADMIN_USER.id, kind: "extension", payload: { mode: "author", type: "tool", name: "host-evaluation-probe" } });
  const directory = getExtensionAuthorDraftDir(draft.id, ADMIN_USER.id);
  const marker = join(root, `${draft.id}.marker`);
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "ezcorp.config.ts"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'host code executed');export default {};`);
  return { draft, directory, marker };
}

for (const operation of ["install", "validate", "verify-rpc", "install-rpc", "load", "load-fresh"] as const) test(`untrusted config cannot execute on the host through ${operation}`, async () => {
  const { draft, directory, marker } = await hostileDraft();
  if (operation === "install" || operation === "validate") {
    const event = createMockEvent({ method: "POST", user: ADMIN_USER, authMethod: "session", params: { id: draft.id }, body: { draftId: draft.id } });
    const response = await (operation === "install" ? install(event as never) : validate(event as never));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "extension_v4_required" });
  } else if (operation === "verify-rpc" || operation === "install-rpc") {
    const response = await handleDraftsRpc("extension-author", { jsonrpc: "2.0", id: "probe", method: "ezcorp/drafts", params: { action: operation === "verify-rpc" ? "verify" : "install", draftId: draft.id } }, { userId: ADMIN_USER.id, grantedPermissions: { custom: { drafts: { kinds: ["extension"] } }, grantedAt: {} } });
    expect(response).toMatchObject({ error: { code: -32601, data: { code: "extension_v4_required" } } });
  } else {
    await expect(operation === "load" ? loadManifest(directory) : loadManifestFresh(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});
