/**
 * Client transport contracts. Each entry executes a public API wrapper and
 * asserts the route and verb the server authorizes. This catches a UI call
 * drifting from its endpoint without treating an import as coverage.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as api from "../../web/src/lib/api.ts";

type ApiFunction = (...args: unknown[]) => Promise<unknown>;
type Contract = readonly [name: keyof typeof api, args: readonly unknown[], path: string, method?: string];
type Call = { path: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({ runs: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => { globalThis.fetch = originalFetch; });

const contracts: readonly Contract[] = [
  ["fetchAgents", [], "/api/agents"], ["fetchRuns", ["p"], "/api/runs?projectId=p"],
  ["fetchRun", ["r"], "/api/runs/r"], ["triggerRun", ["agent", { prompt: "x" }, "p"], "/api/agents/agent/run", "POST"],
  ["fetchDirContents", ["a b"], "/api/fs/list?dir=a%20b"], ["createDir", ["folder"], "/api/fs/mkdir", "POST"],
  ["fetchProjects", [], "/api/projects"], ["fetchFavicon", ["https://a.test/a b"], "/api/favicon?url=https%3A%2F%2Fa.test%2Fa%20b"],
  ["createProject", [{ name: "n", path: "/p" }], "/api/projects", "POST"], ["updateProject", ["p", { name: "n" }], "/api/projects/p", "PUT"], ["deleteProject", ["p"], "/api/projects/p", "DELETE"],
  ["fetchSettings", [], "/api/settings"], ["upsertSetting", ["k", true], "/api/settings/k", "PUT"], ["deleteSetting", ["k"], "/api/settings/k", "DELETE"],
  ["refreshProviderModels", ["openai"], "/api/providers/openai/refresh-models", "POST"], ["testLocalModelConnection", ["http://local", "m"], "/api/providers/local/test", "POST"], ["listLocalModels", ["http://local"], "/api/providers/local/models", "POST"],
  ["searchMessages", ["p", "two words", { mode: "semantic", scope: "all", limit: 4, offset: 2 }], "/api/search/messages?projectId=p&q=two+words&mode=semantic&scope=all&limit=4&offset=2"],
  ["fetchConversation", ["c"], "/api/conversations/c"], ["fetchConversations", ["p", { limit: 4, offset: 2 }], "/api/conversations?projectId=p&limit=4&offset=2"],
  ["createConversation", [{ projectId: "p", title: "t" }], "/api/conversations", "POST"], ["searchConversations", ["p", "two words"], "/api/conversations?projectId=p&search=two%20words"],
  ["updateConversation", ["c", { title: "t" }], "/api/conversations/c", "PUT"], ["deleteConversation", ["c"], "/api/conversations/c", "DELETE"],
  ["updateMcpServer", ["m", { description: "d", server: { transport: "stdio", command: "echo", args: [] } }], "/api/mcp-servers/m", "PUT"],
  ["cloneTurns", ["c", { messageIds: ["m"] }], "/api/conversations/c/clone-turns", "POST"], ["patchMessageContent", ["c", "m", "text"], "/api/conversations/c/messages/m", "PATCH"], ["setMessageExcluded", ["c", "m", true], "/api/conversations/c/messages/m", "PATCH"],
  ["fetchModes", [], "/api/modes"], ["createMode", [{ name: "m" }], "/api/modes", "POST"], ["updateMode", ["m", { name: "n" }], "/api/modes/m", "PUT"], ["deleteMode", ["m"], "/api/modes/m", "DELETE"],
  ["createSubConversation", ["c", { parentMessageId: "m", agentConfigId: "a", title: "t", projectId: "p" }], "/api/conversations", "POST"], ["fetchSubConversations", ["c"], "/api/conversations/c/sub-conversations"], ["fetchTestConversations", ["a"], "/api/agents/a/test-conversations"], ["deleteTestConversations", ["a"], "/api/agents/a/test-conversations", "DELETE"], ["fetchAllMessages", ["c"], "/api/conversations/c/messages?all=true"],
  ["fetchConversationTree", ["c"], "/api/conversations/c/tree"], ["rewindConversation", ["c", "m", "summary"], "/api/conversations/c/rewind", "POST"], ["retryMessage", ["c", "m", { provider: "openai", model: "gpt", thinkingLevel: "high" }], "/api/conversations/c/messages/m/retry", "POST"], ["sendMessage", ["c", { content: "hello", provider: "openai", model: "gpt" }], "/api/conversations/c/messages", "POST"],
  ["fetchAgentConfigs", [], "/api/agent-configs"], ["fetchAgentConfig", ["a"], "/api/agent-configs/a"], ["createAgentConfig", [{ name: "a" }], "/api/agent-configs", "POST"], ["updateAgentConfig", ["a", { name: "b" }], "/api/agent-configs/a", "PUT"],
  ["fetchWorkflows", [], "/api/workflows"], ["createWorkflow", [{ name: "w", description: "d", steps: [] }], "/api/workflows", "POST"], ["deleteWorkflow", ["ext:run"], "/api/workflows/ext%3Arun", "DELETE"], ["fetchWorkflow", ["ext:run"], "/api/workflows/ext%3Arun"], ["updateWorkflow", ["w", { description: "d" }], "/api/workflows/w", "PUT"], ["forkWorkflow", ["w", { projectId: "p", name: "copy", visibility: "private" }], "/api/workflows/w/fork", "POST"], ["dryRunWorkflow", ["w", { input: { x: 1 } }], "/api/workflows/w/dry-run", "POST"], ["fetchWorkflowVersions", ["w"], "/api/workflows/w/versions"], ["fetchWorkflowRuns", ["w", 2], "/api/workflows/runs?workflowName=w&limit=2"], ["fetchWorkflowRunTrace", ["run/a"], "/api/workflows/runs/run%2Fa"], ["triggerWorkflowRun", ["w", { x: 1 }, "p"], "/api/workflows/w/run", "POST"],
  ["browseMarketplace", [{ q: "x", category: "tools", tag: "a", sort: "recent", limit: 2, offset: 1 }], "/api/marketplace?q=x&category=tools&tag=a&sort=recent&limit=2&offset=1"], ["fetchMarketplaceCategories", [], "/api/marketplace/categories"], ["getMarketplaceListing", ["l"], "/api/marketplace/l"], ["publishToMarketplace", ["a", { version: "1" }], "/api/marketplace", "POST"], ["installMarketplaceAgent", ["l", "1"], "/api/marketplace/l/install", "POST"], ["rateMarketplaceListing", ["l", true], "/api/marketplace/l/rate", "POST"], ["importManifest", [{ name: "x" }], "/api/marketplace/import", "POST"],
  ["updateMemoryInjectionEligibility", ["m", true], "/api/memories/m", "PATCH"], ["searchMentions", ["x", "agent", "p"], "/api/mentions/search?q=x&type=agent&projectId=p"], ["fetchUserCommands", [], "/api/user-commands"], ["fetchUserCommand", ["a/b"], "/api/user-commands/a%2Fb"], ["createUserCommand", [{ name: "x", body: "b" }], "/api/user-commands", "POST"], ["updateUserCommand", ["a/b", { body: "b" }], "/api/user-commands/a%2Fb", "PATCH"], ["deleteUserCommand", ["a/b"], "/api/user-commands/a%2Fb", "DELETE"],
  ["importPreview", [new FormData()], "/api/import/preview", "POST"], ["importCommit", [{ sessionId: "s", projectId: "p", files: [], skills: [] }], "/api/import/commit", "POST"], ["uninstallExtension", ["ext/a"], "/api/extensions/ext%2Fa", "DELETE"], ["removeImportedSkill", ["i"], "/api/extensions/control", "POST"],
];

describe("public API wrappers preserve their server route contracts", () => {
  for (const [name, args, path, method = "GET"] of contracts) {
    test(String(name), async () => {
      const candidate = Object.getOwnPropertyDescriptor(api, name)?.value;
      expect(typeof candidate).toBe("function");
      await (candidate as ApiFunction)(...args);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe(path);
      expect(calls[0]!.init?.method ?? "GET").toBe(method);
    });
  }

  test("validates extension review redirects before navigation", () => {
    expect(api.extensionReviewLocation({ openUrl: "/extensions/author?installation=i" })).toBe("/extensions/author?installation=i");
    expect(() => api.extensionReviewLocation({ openUrl: "https://evil.test/extensions/author?installation=i" })).toThrow("invalid extension review location");
  });

  test("downloads conversation and manifest exports with server filenames", async () => {
    const originalDocument = globalThis.document;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const clicks: Array<{ href: string; download: string }> = [];
    const created: Array<{ href: string; download: string; click: () => void }> = [];
    globalThis.document = {
      createElement: (tag: string) => {
        expect(tag).toBe("a");
        const link = { href: "", download: "", click: () => clicks.push({ href: link.href, download: link.download }) };
        created.push(link);
        return link;
      },
    } as unknown as Document;
    URL.createObjectURL = () => "blob:api-contract";
    URL.revokeObjectURL = (url: string) => { expect(url).toBe("blob:api-contract"); };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ path: String(input) });
      return new Response("export", { headers: { "Content-Disposition": 'attachment; filename="server-name.json"' } });
    }) as typeof fetch;
    try {
      await api.exportConversation("c", "json", "leaf");
      await api.exportManifest("listing");
      expect(calls.map((call) => call.path)).toEqual([
        "/api/conversations/c/export?format=json&leafMessageId=leaf",
        "/api/marketplace/export/listing",
      ]);
      expect(clicks).toEqual([
        { href: "blob:api-contract", download: "server-name.json" },
        { href: "blob:api-contract", download: "server-name.json" },
      ]);
    } finally {
      globalThis.document = originalDocument;
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  test("deduplicates successful command and feature lookups without caching misses", async () => {
    api._resetCommandBodyCache();
    api._resetFeatureDetailsCache();
    const responses = [
      [{ kind: "command", name: "review", body: "check changes" }],
      [{ id: "f1", name: "search" }],
      { id: "f1", name: "search", description: "d", files: [] },
      [],
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push({ path: String(input) });
      return new Response(JSON.stringify(responses.shift()!), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect(await Promise.all([api.fetchCommandBody("review", "p"), api.fetchCommandBody("review", "p")])).toEqual(["check changes", "check changes"]);
    expect(await api.fetchFeatureDetails("search", "p")).toMatchObject({ id: "f1", name: "search" });
    expect(await api.fetchFeatureDetails("search", "p")).toMatchObject({ id: "f1", name: "search" });
    expect(await api.fetchFeatureDetails("", "p")).toBeNull();
    expect(await api.fetchFeatureDetails("missing", "p")).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/mentions/search?q=review&type=cmd&projectId=p",
      "/api/projects/p/features",
      "/api/projects/p/features/f1",
      "/api/projects/p/features",
    ]);
  });
});
