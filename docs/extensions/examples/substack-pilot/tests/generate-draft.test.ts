import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  generateSubstackDraft,
  composeUserPrompt,
  defaultTitle,
  defaultSubtitle,
  _setMcpCallerForTests,
  _setMcpClientFactoryForTests,
  _setLlmForTests,
  _setLlmModelForTests,
  _resetProductionCallerForTests,
  _setPostTypeStoreForTests,
  _resetPostTypeStoreForTests,
  type McpCaller,
  type PostType,
} from "../lib/substack";
import {
  _setBackendsForTests,
  _resetBackendsForTests,
  type UrlSummary,
} from "../lib/summarize";

// ── Phase 7 port — post-type record helper ─────────────────────
//
// `lib/post-types.ts` was deleted in the defineEntity SDK port; post
// types now live under the SDK's managed namespace at
// `__entity:post-type:<slug>`. This helper plants a record at that
// key shape on the test store, matching what the SDK's
// `create_post_type` tool would write.
async function createPostType(
  store: {
    set<T>(key: string, value: T): Promise<unknown>;
  },
  record: PostType & { slug: string },
): Promise<void> {
  const { slug, ...data } = record;
  await store.set(`__entity:post-type:${slug}`, data);
}

// ── Shared fakes ────────────────────────────────────────────────

function makeStore() {
  const map = new Map<string, unknown>();
  const calls: Array<{ action: string; key: string; value?: unknown }> = [];
  return {
    map,
    calls,
    store: {
      async get<T>(key: string) {
        calls.push({ action: "get", key });
        if (map.has(key)) return { value: map.get(key) as T, exists: true };
        return { value: null, exists: false };
      },
      async set<T>(key: string, value: T) {
        calls.push({ action: "set", key, value });
        map.set(key, value);
        return { ok: true as const, sizeBytes: 0 };
      },
      async delete(key: string) {
        calls.push({ action: "delete", key });
        const had = map.has(key);
        map.delete(key);
        return { deleted: had };
      },
    },
  };
}

interface CapturedComposeCall {
  systemPrompt?: string;
  userContent: string;
  maxTokens?: number;
}

function makeComposeLlm(answer: string) {
  const calls: CapturedComposeCall[] = [];
  let throwErr: Error | undefined;
  const llm = {
    async complete(args: {
      provider: string;
      model: string;
      systemPrompt?: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
    }) {
      if (throwErr) throw throwErr;
      const userContent = args.messages.find((m) => m.role === "user")?.content ?? "";
      calls.push({
        ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
        userContent,
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      });
      return { content: answer };
    },
  };
  return {
    calls,
    llm,
    setThrow: (e: Error | undefined) => {
      throwErr = e;
    },
  };
}

function makeMcpCaller(
  impl?: (
    tool: string,
    args: Record<string, unknown>,
  ) => { ok: true; text: string } | { ok: false; error: string },
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const caller: McpCaller = {
    async call(tool, args) {
      calls.push({ tool, args });
      if (impl) return impl(tool, args);
      return { ok: true, text: "OK" };
    },
  };
  return { calls, caller };
}

function text(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text;
}

let storeKit: ReturnType<typeof makeStore>;

beforeEach(() => {
  storeKit = makeStore();
  _setPostTypeStoreForTests(storeKit.store);
});

afterEach(() => {
  _resetPostTypeStoreForTests();
  _resetBackendsForTests();
  _resetProductionCallerForTests();
});

// ── Pure helpers ────────────────────────────────────────────────

describe("composeUserPrompt", () => {
  test("includes the post type and every successful summary", () => {
    const postType: PostType = {
      slug: "weekly",
      name: "Weekly Roundup",
      systemPrompt: "ignored at compose level",
      cadence: "weekly",
    };
    const summaries: UrlSummary[] = [
      { url: "https://x.test/a", title: "A", summary: "first" },
      { url: "https://x.test/b", title: "B", summary: "second" },
    ];
    const out = composeUserPrompt(postType, summaries);
    expect(out).toContain("Weekly Roundup");
    expect(out).toContain("weekly");
    expect(out).toContain("https://x.test/a");
    expect(out).toContain("first");
    expect(out).toContain("https://x.test/b");
    expect(out).toContain("second");
  });

  test("omits failed URLs and notes the count", () => {
    const postType: PostType = { slug: "x", name: "X", systemPrompt: "p" };
    const summaries: UrlSummary[] = [
      { url: "https://x.test/a", title: "A", summary: "ok" },
      { url: "https://x.test/b", title: "B", summary: "", error: "HTTP 404" },
    ];
    const out = composeUserPrompt(postType, summaries);
    expect(out).toContain("https://x.test/a");
    expect(out).not.toContain("https://x.test/b");
    expect(out).toContain("1 URL(s) failed");
  });
});

describe("defaultTitle / defaultSubtitle", () => {
  test("override wins over the prefix", () => {
    const pt: PostType = {
      slug: "x",
      name: "X",
      systemPrompt: "p",
      defaults: { titlePrefix: "Pre " },
    };
    expect(defaultTitle(pt, [], "Override Title")).toBe("Override Title");
  });
  test("uses titlePrefix + ISO date when no override", () => {
    const pt: PostType = {
      slug: "x",
      name: "X",
      systemPrompt: "p",
      defaults: { titlePrefix: "This Week: " },
    };
    const out = defaultTitle(pt, []);
    expect(out.startsWith("This Week: ")).toBe(true);
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  test("falls back to '<name> — <date>' when no prefix", () => {
    const pt: PostType = { slug: "x", name: "X", systemPrompt: "p" };
    expect(defaultTitle(pt, [])).toMatch(/^X — \d{4}-\d{2}-\d{2}$/);
  });
  test("subtitle template expands {date} and {count}", () => {
    const pt: PostType = {
      slug: "x",
      name: "X",
      systemPrompt: "p",
      defaults: { subtitleTemplate: "{date} • {count} links" },
    };
    const summaries: UrlSummary[] = [
      { url: "a", title: "a", summary: "s" },
      { url: "b", title: "b", summary: "s" },
      { url: "c", title: "c", summary: "", error: "X" },
    ];
    const out = defaultSubtitle(pt, summaries);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} • 2 links$/);
  });
  test("subtitle empty when no template + no override", () => {
    const pt: PostType = { slug: "x", name: "X", systemPrompt: "p" };
    expect(defaultSubtitle(pt, [])).toBe("");
  });
});

// ── End-to-end generate_substack_draft ──────────────────────────

function seedSuccessfulFetchAndSummaryLlm(answers: string[]) {
  // Provide canned HTML + LLM summaries for any URL passed in.
  let i = 0;
  const fakeFetch = async (url: string) => ({
    ok: true,
    status: 200,
    text: async () =>
      `<html><head><title>Title for ${url}</title></head><body>Body for ${url}.</body></html>`,
  });
  const summaryLlm = {
    async complete() {
      const out = answers[i] ?? `summary-${i}`;
      i++;
      return { content: out };
    },
  };
  _setBackendsForTests({ fetch: fakeFetch, llm: summaryLlm });
}

describe("generateSubstackDraft", () => {
  test("happy path: looks up post type, summarizes, composes, calls MCP", async () => {
    await createPostType(storeKit.store, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "MARK weekly system prompt",
      cadence: "weekly",
      defaults: { titlePrefix: "This Week: ", subtitleTemplate: "{date} • {count}" },
    });

    seedSuccessfulFetchAndSummaryLlm(["sum-A", "sum-B"]);

    const composeKit = makeComposeLlm("Composed body text.");
    _setLlmForTests(composeKit.llm);
    _setLlmModelForTests("anthropic", "claude-3-5-haiku-20241022");

    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a", "https://x.test/b"],
    });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(text(res)) as {
      ok: boolean;
      title: string;
      subtitle: string;
      urlsSummarized: number;
      urlsFailed: number;
      mcpResponse: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.urlsSummarized).toBe(2);
    expect(parsed.urlsFailed).toBe(0);
    expect(parsed.title.startsWith("This Week: ")).toBe(true);
    expect(parsed.subtitle).toMatch(/\d{4}-\d{2}-\d{2} • 2/);
    expect(parsed.mcpResponse).toBe("OK");

    // The compose LLM saw the post type's systemPrompt as the system
    // message — that's the contract: post type prompt is the controlling
    // guidance for body composition.
    expect(composeKit.calls).toHaveLength(1);
    expect(composeKit.calls[0]?.systemPrompt).toBe("MARK weekly system prompt");
    expect(composeKit.calls[0]?.userContent).toContain("sum-A");
    expect(composeKit.calls[0]?.userContent).toContain("sum-B");

    // The MCP caller saw the {title, subtitle, body} args.
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]?.tool).toBe("create_draft_post");
    const mcpArgs = mcp.calls[0]?.args ?? {};
    expect(mcpArgs.title).toBe(parsed.title);
    expect(mcpArgs.subtitle).toBe(parsed.subtitle);
    expect(mcpArgs.body).toBe("Composed body text.");
  });

  test("respects titleOverride and subtitleOverride", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a"],
      titleOverride: "Custom Title",
      subtitleOverride: "Custom Subtitle",
    });
    expect(mcp.calls[0]?.args.title).toBe("Custom Title");
    expect(mcp.calls[0]?.args.subtitle).toBe("Custom Subtitle");
  });

  test("subtitle key is always sent even when empty (substack-mcp v1.0.7 requires it)", async () => {
    // substack-mcp@1.0.7 declares `subtitle: z.string()` (not .optional()).
    // Omitting the key fails zod validation upstream and surfaces as
    // MCP_ERROR. This test pins that we always send the key, sending ""
    // when the post type has no subtitleTemplate and no override.
    await createPostType(storeKit.store, { slug: "no-sub", name: "NoSub", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    await generateSubstackDraft({
      postTypeSlug: "no-sub",
      urls: ["https://x.test/a"],
    });
    expect(mcp.calls).toHaveLength(1);
    expect(Object.keys(mcp.calls[0]?.args ?? {})).toContain("subtitle");
    expect(mcp.calls[0]?.args.subtitle).toBe("");
  });

  test("missing post type returns NOT_FOUND, no MCP call", async () => {
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "ghost",
      urls: ["https://x.test/a"],
    });
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("NOT_FOUND");
    expect(mcp.calls).toHaveLength(0);
  });

  test("all URLs failing returns a tool error with per-URL detail", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    // Force every fetch to fail.
    _setBackendsForTests({
      fetch: async () => {
        throw new Error("network down");
      },
      llm: { async complete() { return { content: "x" }; } },
    });
    _setLlmForTests(makeComposeLlm("body").llm);
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a", "https://x.test/b"],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("All 2 URL(s) failed");
    expect(mcp.calls).toHaveLength(0);
  });

  test("MCP returning error → structured error, no half-state", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    const mcp = makeMcpCaller(() => ({ ok: false, error: "401 unauthorized" }));
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a"],
    });
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("MCP_ERROR");
    expect(text(res)).toContain("401 unauthorized");
  });

  test("missing credentials + no injected caller returns MISSING_CREDENTIALS", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    // Explicitly clear the test caller.
    _setMcpCallerForTests(null);

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      { invocationMetadata: { settings: {} } },
    );
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("MISSING_CREDENTIALS");
  });

  test("empty body from compose LLM → tool error, no MCP call", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("   ").llm); // whitespace only
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a"],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("empty body");
    expect(mcp.calls).toHaveLength(0);
  });

  test("LLM compose failure surfaces cleanly", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    const k = makeComposeLlm("");
    k.setThrow(new Error("quota burned"));
    _setLlmForTests(k.llm);
    const mcp = makeMcpCaller();
    _setMcpCallerForTests(mcp.caller);

    const res = await generateSubstackDraft({
      postTypeSlug: "weekly",
      urls: ["https://x.test/a"],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("quota burned");
    expect(mcp.calls).toHaveLength(0);
  });
});

// ── Argument validation ────────────────────────────────────────

describe("generateSubstackDraft argument validation", () => {
  test("non-string postTypeSlug", async () => {
    const res = await generateSubstackDraft({ postTypeSlug: 1, urls: ["a"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("string 'postTypeSlug'");
  });
  test("urls must be a non-empty array", async () => {
    const res = await generateSubstackDraft({ postTypeSlug: "x", urls: [] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("non-empty 'urls'");
  });
  test("urls must contain at least one string", async () => {
    const res = await generateSubstackDraft({ postTypeSlug: "x", urls: [1, true] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("at least one string URL");
  });
  test("titleOverride must be a string when provided", async () => {
    const res = await generateSubstackDraft({
      postTypeSlug: "x",
      urls: ["a"],
      titleOverride: 1,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("'titleOverride'");
  });
  test("subtitleOverride must be a string when provided", async () => {
    const res = await generateSubstackDraft({
      postTypeSlug: "x",
      urls: ["a"],
      subtitleOverride: 1,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("'subtitleOverride'");
  });
});

// ── Production-caller wiring (via injected MCP client factory) ──
//
// These tests cover lib/substack.ts:getProductionCaller — specifically
// the post-SDK-import wiring: transport-env shaping, callTool routing,
// and isError surfacing. The dynamic `await import(...)` itself is NOT
// under test (it's a one-liner that yields control to the SDK package).

describe("getProductionCaller wiring (via _setMcpClientFactoryForTests)", () => {
  test("happy path: spawn args + env shape are correct, MCP text surfaces", async () => {
    await createPostType(storeKit.store, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "p",
      defaults: { titlePrefix: "W: " },
    });
    seedSuccessfulFetchAndSummaryLlm(["sum-A"]);
    _setLlmForTests(makeComposeLlm("Body content.").llm);

    // Capture what getProductionCaller hands to the factory.
    let capturedTransport: {
      command: string;
      args: string[];
      env: Record<string, string>;
    } | null = null;
    const fakeClientCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    _setMcpClientFactoryForTests(async (transport) => {
      capturedTransport = transport;
      return {
        async callTool(req) {
          fakeClientCalls.push({
            name: req.name,
            arguments: req.arguments,
          });
          return { content: [{ type: "text", text: "OK" }], isError: false };
        },
      };
    });
    // Explicitly clear the injected caller so generateSubstackDraft
    // falls through to getProductionCaller (which then invokes the
    // factory we just registered).
    _setMcpCallerForTests(null);

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "tok-xyz",
            substack_user_id: "12345",
          },
        },
      },
    );

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(text(res)) as { mcpResponse: string };
    expect(parsed.mcpResponse).toBe("OK");

    // Transport spec: exact spawn shape — `npx -y substack-mcp@latest`.
    expect(capturedTransport).not.toBeNull();
    const tt = capturedTransport as unknown as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(tt.command).toBe("npx");
    expect(tt.args).toEqual(["-y", "substack-mcp@latest"]);

    // Env shape: only the SUBSTACK_* settings + PATH + HOME. Critically,
    // we must NOT leak the host's process.env into the child.
    expect(tt.env.SUBSTACK_PUBLICATION_URL).toBe("https://me.substack.com");
    expect(tt.env.SUBSTACK_SESSION_TOKEN).toBe("tok-xyz");
    expect(tt.env.SUBSTACK_USER_ID).toBe("12345");
    expect(typeof tt.env.PATH).toBe("string");
    expect(typeof tt.env.HOME).toBe("string");
    // Allowlist: exactly these 5 keys, nothing else.
    expect(Object.keys(tt.env).sort()).toEqual([
      "HOME",
      "PATH",
      "SUBSTACK_PUBLICATION_URL",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
    ]);

    // Tool routing: the caller forwarded create_draft_post to the client.
    expect(fakeClientCalls).toHaveLength(1);
    expect(fakeClientCalls[0]?.name).toBe("create_draft_post");
    expect(fakeClientCalls[0]?.arguments.title).toMatch(/^W: \d{4}-\d{2}-\d{2}$/);
    expect(fakeClientCalls[0]?.arguments.body).toBe("Body content.");
  });

  test("MCP isError → MCP_ERROR tool error with upstream text", async () => {
    await createPostType(storeKit.store, { slug: "weekly", name: "W", systemPrompt: "p" });
    seedSuccessfulFetchAndSummaryLlm(["s"]);
    _setLlmForTests(makeComposeLlm("body").llm);

    _setMcpClientFactoryForTests(async () => ({
      async callTool() {
        return { content: [{ type: "text", text: "401" }], isError: true };
      },
    }));
    _setMcpCallerForTests(null);

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "tok-xyz",
            substack_user_id: "12345",
          },
        },
      },
    );
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("MCP_ERROR");
    expect(text(res)).toContain("401");
  });
});
