
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  getTestPglite,
} from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  useTempProjectRoot,
  type TempProjectRoot,
} from "../../__tests__/helpers/temp-project-root";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

mock.module("../../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { handleDraftsRpc } = await import("../drafts-handler");
const { getDb } = await import("../../db/connection");
const { users } = await import("../../db/schema");
const { scaffoldExtension } = await import("@ezcorp/sdk");
const { getExtensionAuthorDraftDir } = await import("../../db/queries/ez-drafts");

import type { JsonRpcRequest, ExtensionPermissions } from "../types";
import type { DraftsContext } from "../drafts-handler";

const ALLOWED_NAME = "extension-author";
const USER = "user-verify-rpc";
const OTHER_USER = "user-verify-rpc-other";

function makeCtx(userId = USER): DraftsContext {
  const perms: ExtensionPermissions = {
    grantedAt: {},
    custom: { drafts: { kinds: ["extension"] } },
  };
  return { userId, grantedPermissions: perms };
}

function rpc(params: Record<string, unknown>, id: string = "v"): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/drafts", params };
}

// Every draft here is materialized on disk under
// `getProjectRoot()/.ezcorp/extension-data/…`, and `verifyExtension()`
// spawns a real sandboxed subprocess out of that directory. The root is
// anchored on `bundled.ts`'s own module path, so without this override
// the scaffolds land in the real checkout — EACCES wherever
// `.ezcorp/extension-data` belongs to another uid. `useTempProjectRoot()`
// relocates the root AND links `node_modules`/`packages` in, so the
// subprocess still resolves `@ezcorp/sdk`.
let tmpRoot: TempProjectRoot;

async function makeAuthorDraft(): Promise<string> {
  const create = await handleDraftsRpc(
    ALLOWED_NAME,
    rpc(
      {
        action: "create",
        kind: "extension",
        payload: { name: "x", type: "tool", mode: "author" },
        // Host-owned create now REQUIRES files; writeScaffold() below
        // overwrites these with the real scaffold (incl. mutations).
        files: { "ezcorp.config.ts": "export default {};\n" },
      },
      "c",
    ),
    makeCtx(),
  );
  return (create.result as { draftId: string }).draftId;
}

function writeScaffold(
  draftId: string,
  type: "tool" | "multi",
  mutate?: (files: Record<string, string>) => void,
): void {
  const dir = getExtensionAuthorDraftDir(draftId, USER);
  // The `.ezcorp/extension-data/<name>/…` layout is binding
  // (src/extensions/CLAUDE.md); asserting it against the temp root keeps
  // the shape pinned AND proves nothing lands in the real checkout.
  expect(dir).toBe(
    join(tmpRoot.root, ".ezcorp/extension-data/extension-author/drafts", USER, draftId),
  );
  mkdirSync(dir, { recursive: true });
  const { files } = scaffoldExtension({
    name: `verify-rpc-${type}`,
    type,
    description: "drafts.verify e2e",
  });
  mutate?.(files);
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, n)), { recursive: true });
    writeFileSync(`${dir}/${n}`, c);
  }
}

beforeAll(async () => {
  tmpRoot = useTempProjectRoot("drafts-verify-");
  await setupTestDb();
  for (const id of [USER, OTHER_USER]) {
    await getDb()
      .insert(users)
      .values({
        id,
        email: `${id}@t.local`,
        passwordHash: "x",
        name: id,
      } as never)
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
  // Removes every scaffolded draft dir with the root itself.
  tmpRoot.cleanup();
});

describe("ezcorp/drafts.verify — param + ownership", () => {
  test("missing draftId still returns the v4 cutover", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32601);
  });

  test("unknown draftId returns opaque v4 cutover", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId: "00000000-0000-0000-0000-000000000000" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.data).toMatchObject({ code: "extension_v4_required" });
    expect(resp.result).toBeUndefined();
  });

  test("non-owner receives the same opaque cutover", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool");
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(OTHER_USER),
    );
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.data).toMatchObject({ code: "extension_v4_required" });
    expect(resp.result).toBeUndefined();
  });
});

describe("ezcorp/drafts.verify — VerifyResult shape", () => {
  test("scaffolded tool draft cannot bypass an isolated release build", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool");
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.data).toMatchObject({ code: "extension_v4_required", openUrl: "/extensions/author" });
    expect(resp.result).toBeUndefined();
  }, 25_000);

  test("executable draft never runs through the removed verify action", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool", (files) => {
      files["extension.ts"] = "throw new Error('UNTRUSTED_DRAFT_EXECUTED')";
    });
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.data).toMatchObject({ code: "extension_v4_required" });
    expect(resp.error?.message).not.toContain("UNTRUSTED_DRAFT_EXECUTED");
    expect(resp.result).toBeUndefined();
  }, 25_000);
});
