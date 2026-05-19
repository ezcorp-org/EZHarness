/**
 * Phase C — `ezcorp/drafts.verify` reverse-RPC action.
 *
 * The bundled `extension-author` subprocess cannot import the host's
 * `verifyExtension` (sandbox-preload poisons fs; host module not
 * reachable). `validate_extension` reverse-RPCs `{action:"verify"}` so
 * the LLM gets the host's structured VerifyResult as the machine
 * verdict — root-cause fix #4 (hand-rolled bypass). This drives that
 * host-side action end-to-end against a real scaffolded draft on disk.
 *
 * Owner-scoping mirrors `resolveDir`; the pass/fail verdict comes from
 * the canonical `verifyExtension` pipeline (real subprocess round-trip).
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  getTestPglite,
} from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

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

const createdDirs: string[] = [];

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
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  const { files } = scaffoldExtension({
    name: `verify-rpc-${type}`,
    type,
    description: "drafts.verify e2e",
  });
  mutate?.(files);
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(`${dir}/${n}`, c);
  }
}

beforeAll(async () => {
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
  for (const d of createdDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  await closeTestDb();
  restoreModuleMocks();
});

describe("ezcorp/drafts.verify — param + ownership", () => {
  test("missing draftId → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("unknown draftId → -32603 (opaque)", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId: "00000000-0000-0000-0000-000000000000" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32603);
  });

  test("non-owner → -32603 (same as missing)", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool");
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(OTHER_USER),
    );
    expect(resp.error?.code).toBe(-32603);
  });
});

describe("ezcorp/drafts.verify — VerifyResult shape", () => {
  test("scaffolded tool draft ⇒ pass:true + steps[]", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool");
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      pass: boolean;
      steps: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(result.pass).toBe(true);
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.some((s) => s.name === "smoke-test-roundtrip" && s.ok)).toBe(
      true,
    );
  }, 25_000);

  test("draft with a broken smokeTest tool ⇒ pass:false + failing step", async () => {
    const draftId = await makeAuthorDraft();
    writeScaffold(draftId, "tool", (files) => {
      // Point smokeTest at a tool the manifest does NOT declare — the
      // canonical validator must reject it (machine verdict, not
      // self-judged).
      files["ezcorp.config.ts"] = files["ezcorp.config.ts"]!.replace(
        /tool: "verify-rpc-tool-example"/,
        'tool: "ghost-tool"',
      );
    });
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "verify", draftId }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      pass: boolean;
      steps: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(result.pass).toBe(false);
    expect(result.steps.some((s) => !s.ok)).toBe(true);
  }, 25_000);
});
