/**
 * DB-audit fixes for the search day-quota (memory-embed group):
 *   - handlePiSearch now HYDRATES the in-process counter from the durable
 *     extension_search_calls_daily row BEFORE the first consume (mirrors
 *     llm-handler). Without it a host restart mid-day re-inits the counter to 0
 *     and hands the extension a fresh budget.
 *   - the durable upsert uses GREATEST(existing, incoming) instead of an
 *     absolute overwrite, so a pre-hydrate first write (or an out-of-order /
 *     multi-instance flush) can never REGRESS the day's count.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

const { handlePiSearch } = await import("../extensions/search-handler");
const { consumeSearchQuota, _resetSearchQuotaForTests } = await import("../search/search-quota");
const { createUser } = await import("../db/queries/users");
const { extensions, conversations, projects, extensionSearchCallsDaily } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
import type { ExtensionPermissions, JsonRpcRequest } from "../extensions/types";
import type { ResolvedSearchPolicy } from "../search/policy";

let userId: string;
let extensionId: string;
let conversationId: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function seedDurable(extId: string, calls: number) {
  await getTestDb().insert(extensionSearchCallsDaily)
    .values({ extensionId: extId, day: today(), calls })
    .onConflictDoUpdate({
      target: [extensionSearchCallsDaily.extensionId, extensionSearchCallsDaily.day],
      set: { calls },
    });
}

async function getDurable(extId: string): Promise<number | undefined> {
  const rows = await getTestDb().select().from(extensionSearchCallsDaily)
    .where(eq(extensionSearchCallsDaily.extensionId, extId));
  return rows[0]?.calls;
}

function rpcMeta(): Record<string, unknown> {
  return { ezOnBehalfOf: userId, ezConversationId: conversationId };
}
function granted(search: ExtensionPermissions["search"]): ExtensionPermissions {
  return { grantedAt: { search: Date.now() }, search };
}
function req(params: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/search", params };
}
const okSearch = (): typeof import("../search/index").performSearch =>
  (async () => ({ markdown: "MD", providerName: "duckduckgo", cached: false })) as never;
const policy = (quota: number): (() => Promise<ResolvedSearchPolicy>) =>
  async () => ({ denied: false, quota, maxResults: 5, providers: "all" });

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "sq-hydrate@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" });
  userId = u.id;
  extensionId = await ensureExtension("sq-hydrate-ext");
  const [proj] = await getTestDb().insert(projects).values({ name: "sq-proj", path: "/tmp/sq" }).returning({ id: projects.id });
  const [conv] = await getTestDb().insert(conversations).values({ projectId: proj!.id, userId, title: "t", kind: "regular" }).returning({ id: conversations.id });
  conversationId = conv!.id;
}, 30_000);

beforeEach(async () => {
  _resetSearchQuotaForTests();
  await getTestDb().delete(extensionSearchCallsDaily);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("handlePiSearch — hydrates the day-quota before the first consume", () => {
  test("a restart-fresh process still enforces the durable count (exhausted → -32103)", async () => {
    // A prior process used all 3/3 of today's budget.
    await seedDurable(extensionId, 3);
    _resetSearchQuotaForTests(); // simulate the restart: in-process counter = 0

    const resp = await handlePiSearch(
      req({ action: "web", query: "bun" }),
      { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch(), resolvePolicy: policy(3) },
      rpcMeta(),
    );

    // WITHOUT the hydrate this would allow (fresh 0/3 budget) and return a result.
    expect(resp.error?.code).toBe(-32103);
    expect(resp.result).toBeUndefined();
  });

  test("under the durable count, the call is allowed", async () => {
    await seedDurable(extensionId, 2); // 2/3 used
    _resetSearchQuotaForTests();

    const resp = await handlePiSearch(
      req({ action: "web", query: "bun" }),
      { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch(), resolvePolicy: policy(3) },
      rpcMeta(),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
  });
});

describe("durable upsert is increment-safe (GREATEST — never regresses)", () => {
  test("a pre-hydrate first write does NOT clobber a higher durable count down", async () => {
    // Another instance already recorded 100 calls today.
    await seedDurable(extensionId, 100);
    _resetSearchQuotaForTests(); // fresh process, NO hydrate yet

    // First consume: in-process counter = 1, async flush = GREATEST(existing=100, 1).
    expect(consumeSearchQuota(extensionId, 500).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 40));

    // The durable count must stay 100, not regress to 1.
    expect(await getDurable(extensionId)).toBe(100);
  });

  test("a genuinely higher in-process count still advances the durable value", async () => {
    await seedDurable(extensionId, 1);
    _resetSearchQuotaForTests();
    // Three consumes → in-process 1,2,3; each flush GREATEST-merges upward.
    consumeSearchQuota(extensionId, 500);
    consumeSearchQuota(extensionId, 500);
    consumeSearchQuota(extensionId, 500);
    await new Promise((r) => setTimeout(r, 40));
    expect(await getDurable(extensionId)).toBe(3);
  });
});
