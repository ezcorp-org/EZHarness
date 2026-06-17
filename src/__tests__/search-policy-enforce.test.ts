/**
 * Phase-2 enforcement in `handlePiSearch`: the resolved policy gates the
 * call BEFORE the provider chain runs.
 *
 *   - quota: the Nth call over the per-day limit soft-fails (-32103) and
 *     writes a `SDK_SEARCH_QUOTA_EXCEEDED` audit row (reason
 *     `quota-per-day`). Per-extension/day accounting is proven against
 *     the durable `extension_search_calls_daily` table.
 *   - maxResults: the request is clamped to `min(requested, policy)`.
 *   - providers: a provider outside the allowlist soft-fails (-32101) +
 *     writes `SDK_SEARCH_QUOTA_EXCEEDED` (reason `provider-not-allowed`),
 *     with NO network fetch.
 *   - false grant → denied via the resolved policy.
 *
 * The policy resolver is INJECTED (the `resolvePolicy` seam) so the suite
 * drives the effective policy directly; the DB-backed quota path uses the
 * real `consumeSearchQuota` against test-pglite.
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

import { handlePiSearch } from "../extensions/search-handler";
import { _resetSearchQuotaForTests } from "../search/search-quota";
import { ProviderNotAllowedError } from "../search/index";
import type { ResolvedSearchPolicy } from "../search/policy";
import { createUser } from "../db/queries/users";
import { extensions, conversations, projects, sdkCapabilityCalls, messages, errorLogs, auditLog, extensionSearchCallsDaily } from "../db/schema";
import { eq } from "drizzle-orm";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";
import type { ExtensionPermissions, JsonRpcRequest } from "../extensions/types";
import type { SearchModuleResult, PerformSearchOpts } from "../search/index";

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
  const u = await createUser({ email: "search-enf@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" });
  userId = u.id;
  extensionId = await ensureExtension("search-enf-ext");
  const [proj] = await getTestDb().insert(projects).values({ name: "search-enf-proj", path: "/tmp/search-enf" }).returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb().insert(conversations).values({ projectId, userId, title: "t", kind: "regular" }).returning({ id: conversations.id });
  conversationId = conv!.id;
}, 30_000);

beforeEach(async () => {
  _resetSearchQuotaForTests();
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  await getTestDb().delete(extensionSearchCallsDaily);
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

/** A policy resolver seam returning a fixed effective policy. */
const fixedPolicy = (p: ResolvedSearchPolicy): typeof import("../search/policy").resolveSearchPolicy =>
  (async () => p) as never;

const okSearch = (over: Partial<SearchModuleResult> = {}): typeof import("../search/index").performSearch =>
  (async () => ({ markdown: "MD", providerName: "duckduckgo", cached: false, ...over })) as never;

describe("quota enforcement (DB-backed per-extension/day counter)", () => {
  test("Nth call over the limit → -32103 + SDK_SEARCH_QUOTA_EXCEEDED (quota-per-day)", async () => {
    const policy = fixedPolicy({ denied: false, quota: 2, maxResults: 5, providers: "all" });
    // Two calls within quota.
    for (let i = 0; i < 2; i++) {
      const ok = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch(), resolvePolicy: policy }, rpcMeta());
      expect(ok.error).toBeUndefined();
    }
    // Third call exceeds.
    const over = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch(), resolvePolicy: policy }, rpcMeta());
    expect(over.error?.code).toBe(-32103);
    expect((over.error?.data as { reason?: string }).reason).toBe("quota-per-day");
    expect((over.error?.data as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 20));
    const audit = await getTestDb().select().from(auditLog).where(eq(auditLog.action, EXT_AUDIT_ACTIONS.SDK_SEARCH_QUOTA_EXCEEDED));
    expect(audit.length).toBe(1);
    expect(audit[0]!.target).toBe(extensionId);
    expect((audit[0]!.metadata as { reason?: string }).reason).toBe("quota-per-day");
  });

  test("per-extension/day accounting persists to extension_search_calls_daily", async () => {
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 5, providers: "all" });
    await handlePiSearch(req({ action: "web", query: "a" }), { granted: granted("inherit"), registeredTool: { extensionId }, search: okSearch(), resolvePolicy: policy }, rpcMeta());
    await handlePiSearch(req({ action: "read", url: "https://x" }), { granted: granted("inherit"), registeredTool: { extensionId }, read: (async () => ({ markdown: "p", providerName: "jina", cached: false })) as never, resolvePolicy: policy }, rpcMeta());
    await new Promise((r) => setTimeout(r, 30));
    const rows = await getTestDb().select().from(extensionSearchCallsDaily).where(eq(extensionSearchCallsDaily.extensionId, extensionId));
    expect(rows.length).toBe(1);
    // web + read both count against the day budget.
    expect(rows[0]!.calls).toBe(2);
  });

  test("a denied (false) grant → -32101 before quota is consumed", async () => {
    const policy = fixedPolicy({ denied: true });
    let searched = false;
    const search = (async () => { searched = true; return {} as SearchModuleResult; }) as never;
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted(false), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(resp.error?.code).toBe(-32101);
    expect(searched).toBe(false);
    const rows = await getTestDb().select().from(extensionSearchCallsDaily).where(eq(extensionSearchCallsDaily.extensionId, extensionId));
    expect(rows.length).toBe(0);
  });
});

describe("maxResults clamp", () => {
  test("request over the ceiling clamps to policy.maxResults", async () => {
    let received: PerformSearchOpts | undefined;
    const search = (async (_q: string, opts: PerformSearchOpts) => { received = opts; return { markdown: "MD", providerName: "duckduckgo", cached: false }; }) as never;
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 3, providers: "all" });
    await handlePiSearch(req({ action: "web", query: "bun", maxResults: 50 }), { granted: granted("inherit"), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(received?.maxResults).toBe(3);
    expect(received?.allowedProviders).toBe("all");
  });

  test("request under the ceiling passes through", async () => {
    let received: PerformSearchOpts | undefined;
    const search = (async (_q: string, opts: PerformSearchOpts) => { received = opts; return { markdown: "MD", providerName: "duckduckgo", cached: false }; }) as never;
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 10, providers: "all" });
    await handlePiSearch(req({ action: "web", query: "bun", maxResults: 4 }), { granted: granted("inherit"), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(received?.maxResults).toBe(4);
  });

  test("no requested maxResults → defaults to the policy ceiling", async () => {
    let received: PerformSearchOpts | undefined;
    const search = (async (_q: string, opts: PerformSearchOpts) => { received = opts; return { markdown: "MD", providerName: "duckduckgo", cached: false }; }) as never;
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 6, providers: "all" });
    await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(received?.maxResults).toBe(6);
  });
});

describe("provider allowlist", () => {
  test("the allowlist is threaded into the search module opts", async () => {
    let received: PerformSearchOpts | undefined;
    const search = (async (_q: string, opts: PerformSearchOpts) => { received = opts; return { markdown: "MD", providerName: "searxng", cached: false }; }) as never;
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 5, providers: ["searxng"] });
    await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(received?.allowedProviders).toEqual(["searxng"]);
  });

  test("a disallowed provider (ProviderNotAllowedError) → -32101 + SDK_SEARCH_QUOTA_EXCEEDED (provider-not-allowed), no quota leak", async () => {
    // The module throws when the resolved provider is outside the
    // allowlist (pre-fetch); the handler maps it to a soft deny + audit.
    const search = (async () => { throw new ProviderNotAllowedError("tavily"); }) as never;
    const policy = fixedPolicy({ denied: false, quota: 100, maxResults: 5, providers: ["searxng"] });
    const resp = await handlePiSearch(req({ action: "web", query: "bun" }), { granted: granted("inherit"), registeredTool: { extensionId }, search, resolvePolicy: policy }, rpcMeta());
    expect(resp.error?.code).toBe(-32101);
    expect(resp.error?.message).toContain("tavily");

    await new Promise((r) => setTimeout(r, 20));
    const audit = await getTestDb().select().from(auditLog).where(eq(auditLog.action, EXT_AUDIT_ACTIONS.SDK_SEARCH_QUOTA_EXCEEDED));
    expect(audit.length).toBe(1);
    expect((audit[0]!.metadata as { reason?: string }).reason).toBe("provider-not-allowed");
    expect((audit[0]!.metadata as { provider?: string }).provider).toBe("tavily");
    // The denied call still recorded a failed sdk_capability_calls row.
    const sdk = await getTestDb().select().from(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.extensionId, extensionId));
    expect(sdk.length).toBe(1);
    expect(sdk[0]!.success).toBe(false);
  });
});
