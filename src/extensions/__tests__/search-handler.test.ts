/**
 * Coverage for `handlePiSearch` (`ctx.search.{web,read}` reverse-RPC).
 *
 * The provider chain is INJECTED (the handler's `search`/`read` test
 * seams) so this suite never touches the live provider chain or the
 * network — it exercises the gate (deny on `false`/absent), provenance
 * (host-stamped actor + onBehalfOf), the SDK_SEARCH_QUERY +
 * sdk_capability_calls governance rows, the SSRF egress-block audit hook,
 * and the soft-fail mapping (-32101 disabled / -32105 provider error).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { handlePiSearch } from "../search-handler";
import { createUser } from "../../db/queries/users";
import { extensions, conversations, projects, sdkCapabilityCalls, messages, errorLogs, auditLog } from "../../db/schema";
import { eq } from "drizzle-orm";
import { EXT_AUDIT_ACTIONS } from "../audit-actions";
import type { ExtensionPermissions, JsonRpcRequest } from "../types";
import type { SearchModuleResult, ReadModuleResult, PerformSearchOpts, PerformReadOpts } from "../../search/index";

let userId: string;
let extensionId: string;
let projectId: string;
let conversationId: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "search-h@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" });
  userId = u.id;
  extensionId = await ensureExtension("search-h-ext");
  const [proj] = await getTestDb().insert(projects).values({ name: "search-proj", path: "/tmp/search" }).returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb().insert(conversations).values({ projectId, userId, title: "t", kind: "regular" }).returning({ id: conversations.id });
  conversationId = conv!.id;
}, 30_000);

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function rpcMeta(): Record<string, unknown> {
  return { ezOnBehalfOf: userId, ezConversationId: conversationId };
}

function granted(search: ExtensionPermissions["search"]): ExtensionPermissions {
  return { grantedAt: { search: Date.now() }, search };
}

function req(params: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/search", params };
}

const okSearch = (over: Partial<SearchModuleResult> = {}): typeof import("../../search/index").performSearch =>
  (async () => ({ markdown: "- [a](https://a)", providerName: "duckduckgo", cached: false, ...over })) as never;

const okRead = (over: Partial<ReadModuleResult> = {}): typeof import("../../search/index").performRead =>
  (async () => ({ markdown: "# page", providerName: "jina", cached: false, ...over })) as never;

describe("gate", () => {
  test("absent search grant → -32101 (disabled), no provider call", async () => {
    let called = false;
    const search = (async () => { called = true; return {} as SearchModuleResult; }) as never;
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: { grantedAt: {} }, registeredTool: { extensionId }, search }, rpcMeta());
    expect(resp.error?.code).toBe(-32101);
    expect(called).toBe(false);
  });

  test("search:false → -32101 (disabled)", async () => {
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted(false), registeredTool: { extensionId }, search: okSearch() }, rpcMeta());
    expect(resp.error?.code).toBe(-32101);
  });

  test("search:\"inherit\" allows the call", async () => {
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch() }, rpcMeta());
    expect(resp.error).toBeUndefined();
  });

  test("an override object allows the call", async () => {
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted({ quota: 10 }), registeredTool: { extensionId }, search: okSearch() }, rpcMeta());
    expect(resp.error).toBeUndefined();
  });
});

describe("web", () => {
  test("returns markdown + provider + cached and forwards maxResults", async () => {
    let receivedOpts: PerformSearchOpts | undefined;
    let receivedQuery = "";
    const search = (async (q: string, opts: PerformSearchOpts) => {
      receivedQuery = q;
      receivedOpts = opts;
      return { markdown: "MD", providerName: "searxng", cached: true };
    }) as never;
    const resp = await handlePiSearch(req({ action: "web", query: "bun", maxResults: 7 }), { granted: granted("inherit"), registeredTool: { extensionId }, search }, rpcMeta());
    expect(resp.result).toEqual({ markdown: "MD", provider: "searxng", cached: true });
    expect(receivedQuery).toBe("bun");
    expect(receivedOpts?.maxResults).toBe(7);
  });

  test("missing query → soft-fail", async () => {
    const resp = await handlePiSearch(req({ action: "web" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch() }, rpcMeta());
    expect(resp.error?.code).toBe(-32001);
  });

  test("writes an sdk_capability_calls row + SDK_SEARCH_QUERY audit row", async () => {
    await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch({ providerName: "tavily" }) }, rpcMeta());
    // allow fire-and-forget audit write to flush
    await new Promise((r) => setTimeout(r, 20));
    const sdkRows = await getTestDb().select().from(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.extensionId, extensionId));
    expect(sdkRows.length).toBe(1);
    expect(sdkRows[0]!.capability).toBe("search");
    expect(sdkRows[0]!.action).toBe("web");
    expect(sdkRows[0]!.success).toBe(true);
    const auditRows = await getTestDb().select().from(auditLog).where(eq(auditLog.action, EXT_AUDIT_ACTIONS.SDK_SEARCH_QUERY));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.target).toBe(extensionId);
  });
});

describe("read", () => {
  test("returns markdown + provider and forwards maxChars", async () => {
    let receivedOpts: PerformReadOpts | undefined;
    let receivedUrl = "";
    const read = (async (url: string, opts: PerformReadOpts) => {
      receivedUrl = url;
      receivedOpts = opts;
      return { markdown: "PAGE", providerName: "jina", cached: false };
    }) as never;
    const resp = await handlePiSearch(req({ action: "read", url: "https://x", maxChars: 1234 }), { granted: granted("inherit"), registeredTool: { extensionId }, read }, rpcMeta());
    expect(resp.result).toEqual({ markdown: "PAGE", provider: "jina", cached: false });
    expect(receivedUrl).toBe("https://x");
    expect(receivedOpts?.maxChars).toBe(1234);
  });

  test("missing url → soft-fail", async () => {
    const resp = await handlePiSearch(req({ action: "read" }), { granted: granted("inherit"), registeredTool: { extensionId }, read: okRead() }, rpcMeta());
    expect(resp.error?.code).toBe(-32001);
  });
});

describe("errors + provenance", () => {
  test("unknown action → soft-fail", async () => {
    const resp = await handlePiSearch(req({ action: "bogus" }), { granted: granted("inherit"), registeredTool: { extensionId } }, rpcMeta());
    expect(resp.error?.code).toBe(-32001);
  });

  test("provider error → -32105 (SearchError) + a success:false sdk row", async () => {
    const search = (async () => { throw new Error("Search failed via tavily: Tavily HTTP 401"); }) as never;
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search }, rpcMeta());
    expect(resp.error?.code).toBe(-32105);
    expect(resp.error?.message).toContain("Tavily HTTP 401");
    const sdkRows = await getTestDb().select().from(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.extensionId, extensionId));
    expect(sdkRows.length).toBe(1);
    expect(sdkRows[0]!.success).toBe(false);
  });

  test("an egress block fires the SDK_SEARCH_EGRESS_BLOCKED audit row via onEgressBlocked", async () => {
    // The injected search calls the hook (simulating a guard block during
    // a multi-provider attempt) then throws — mirroring the real chain
    // where guardedFetch fires onBlocked + the provider surfaces an error.
    const search = (async (_q: string, opts: PerformSearchOpts) => {
      opts.onEgressBlocked?.({ reason: "private-ip", target: "searxng → 10.0.0.7", mode: "backend" });
      throw new Error("Search failed via searxng: Egress blocked (private-ip): searxng → 10.0.0.7");
    }) as never;
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search }, rpcMeta());
    expect(resp.error?.code).toBe(-32105);
    await new Promise((r) => setTimeout(r, 20));
    const blocked = await getTestDb().select().from(auditLog).where(eq(auditLog.action, EXT_AUDIT_ACTIONS.SDK_SEARCH_EGRESS_BLOCKED));
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.target).toBe(extensionId);
    const meta = blocked[0]!.metadata as { egressReason?: string; target?: string };
    expect(meta.egressReason).toBe("private-ip");
    expect(meta.target).toBe("searxng → 10.0.0.7");
  });

  test("provenance: actorExtensionId comes from registeredTool, NOT RPC meta (spoof ignored)", async () => {
    await handlePiSearch(
      req({ action: "web", query: "bun" }),
      { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch() },
      { ...rpcMeta(), actorExtensionId: "evil-ext" },
    );
    await new Promise((r) => setTimeout(r, 20));
    const sdkRows = await getTestDb().select().from(sdkCapabilityCalls);
    expect(sdkRows[0]!.extensionId).toBe(extensionId); // NOT evil-ext
    expect(sdkRows[0]!.onBehalfOf).toBe(userId);
  });

  test("missing onBehalfOf in rpcMeta throws (handler-context defense)", async () => {
    await expect(
      handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch() }, {}),
    ).rejects.toThrow(/onBehalfOf/);
  });
});
