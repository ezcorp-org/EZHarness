// ── Dynamic @modelcontextprotocol/sdk import path ───────────────
//
// The existing generate-draft.test.ts tests of `getProductionCaller`
// inject a `_setMcpClientFactoryForTests` factory, which short-circuits
// before the real `await import("@modelcontextprotocol/sdk/...")` ever
// runs. Useful, but it doesn't prove the non-factory path resolves at
// runtime in this project's deps.
//
// This test closes that gap by using Bun's `mock.module()` to intercept
// the SDK's two dynamic-import targets BEFORE importing lib/substack.ts.
// We then drive `generateSubstackDraft` end-to-end without the factory
// seam, and assert:
//   - `StdioClientTransport` constructor saw the SUBSTACK_* env shape
//     (PATH + HOME + the three SUBSTACK_* vars; NO host process.env leak)
//   - `Client.connect(transport)` was called with our fake transport
//   - `Client.callTool({name: "create_draft_post", arguments: {...}})`
//     received the composed body/title/subtitle
//   - The result-mapping branch surfaces `OK` on success, and an
//     `MCP_ERROR` tool error on isError:true
//
// If `mock.module` ever stops intercepting the dynamic-import path
// (Bun regression), these tests will fail by trying to actually
// spawn `npx -y substack-mcp@latest` and timing out — that's a louder
// signal than a silent skip.

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";

// ── Fake SDK plumbing ──────────────────────────────────────────
//
// Captures every transport/client interaction so the assertions below
// can pin the exact spawn shape and callTool routing.

interface CapturedTransport {
  command: string;
  args: string[];
  env: Record<string, string>;
}

let capturedTransport: CapturedTransport | null = null;
let capturedClientInit: { name: string; version: string } | null = null;
let capturedConnectTransport: object | null = null;
const capturedCallToolReqs: Array<{
  name: string;
  arguments: Record<string, unknown>;
}> = [];

// Toggleable error-path switch. Set in the isError test, restored after.
let isErrorMode = false;

class FakeStdioClientTransport {
  constructor(opts: CapturedTransport) {
    capturedTransport = opts;
  }
}

class FakeClient {
  constructor(init: { name: string; version: string }, _caps: unknown) {
    capturedClientInit = init;
  }
  async connect(transport: object): Promise<void> {
    capturedConnectTransport = transport;
  }
  async callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
    capturedCallToolReqs.push({ name: req.name, arguments: req.arguments });
    if (isErrorMode) {
      return { content: [{ type: "text", text: "401 from substack" }], isError: true };
    }
    return { content: [{ type: "text", text: "OK" }], isError: false };
  }
}

// IMPORTANT: register the SDK module mocks BEFORE any import that
// reaches into lib/substack.ts. Bun's mock.module hoists its
// intercept registration; subsequent dynamic `await import(...)` calls
// resolve against these factories.
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: FakeClient,
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: FakeStdioClientTransport,
}));

// Now safe to import lib/substack and friends. Doing this at module
// scope (vs lazily inside each test) keeps the production caller's
// singleton-promise initialization deterministic.
import {
  generateSubstackDraft,
  _setMcpCallerForTests,
  _setMcpClientFactoryForTests,
  _setLlmForTests,
  _setLlmModelForTests,
  _resetProductionCallerForTests,
  _setPostTypeStoreForTests,
  _resetPostTypeStoreForTests,
} from "../lib/substack";
import { _setBackendsForTests, _resetBackendsForTests } from "../lib/summarize";

// ── Phase 7 port — local helper for seeding post-type records ────
//
// `lib/post-types.ts` was deleted. The SDK's managed namespace is now
// the source of truth; this helper plants a record at the same key
// shape the SDK's create_post_type tool would use.
async function createPostType(
  store: { set<T>(key: string, value: T): Promise<unknown> },
  record: {
    slug: string;
    name: string;
    systemPrompt: string;
    cadence?: string;
    defaults?: { titlePrefix?: string; subtitleTemplate?: string };
  },
): Promise<void> {
  const { slug, ...data } = record;
  await store.set(`__entity:post-type:${slug}`, data);
}

// ── Shared fakes (copy-trimmed from generate-draft.test.ts) ─────

function makeStore() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      if (map.has(key)) return { value: map.get(key) as T, exists: true };
      return { value: null, exists: false };
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      const had = map.has(key);
      map.delete(key);
      return { deleted: had };
    },
  };
}

function makeComposeLlm(answer: string) {
  return {
    llm: {
      async complete() {
        return { content: answer };
      },
    },
  };
}

function seedSuccessfulFetchAndSummaryLlm(answers: string[]) {
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

function getText(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text;
}

// ── Setup / teardown ───────────────────────────────────────────

let storeKit: ReturnType<typeof makeStore>;

beforeEach(() => {
  storeKit = makeStore();
  _setPostTypeStoreForTests(storeKit);
  capturedTransport = null;
  capturedClientInit = null;
  capturedConnectTransport = null;
  capturedCallToolReqs.length = 0;
  isErrorMode = false;
  // CRITICAL: clear the test caller AND the factory, so generateSubstackDraft
  // falls all the way through to the dynamic-import branch in
  // `getProductionCaller`. That's the branch this file's whole purpose
  // is to exercise.
  _setMcpCallerForTests(null);
  _setMcpClientFactoryForTests(null);
});

afterEach(() => {
  _resetPostTypeStoreForTests();
  _resetBackendsForTests();
  _resetProductionCallerForTests();
});

// ── Tests ──────────────────────────────────────────────────────

describe("dynamic SDK import — happy path", () => {
  test("StdioClientTransport receives the SUBSTACK_* env + PATH + HOME, no leak", async () => {
    await createPostType(storeKit, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "system",
      defaults: { titlePrefix: "W: " },
    });
    seedSuccessfulFetchAndSummaryLlm(["sum-A"]);
    _setLlmForTests(makeComposeLlm("Composed body.").llm);
    _setLlmModelForTests("anthropic", "claude-3-5-haiku-20241022");

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "tok-xyz",
            substack_user_id: "98765",
          },
        },
      },
    );

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(getText(res)) as { mcpResponse: string };
    expect(parsed.mcpResponse).toBe("OK");

    // The transport spawn shape — verbatim what we expect to hand the
    // real `StdioClientTransport`. Pinning `command + args` here also
    // catches a future "let's bundle substack-mcp directly" refactor.
    expect(capturedTransport).not.toBeNull();
    const t = capturedTransport!;
    expect(t.command).toBe("npx");
    expect(t.args).toEqual(["-y", "substack-mcp@latest"]);

    // Env shape: exactly SUBSTACK_* + PATH + HOME. Crucial: no host
    // secrets leak (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_*) —
    // those would be inherited if the caller did `...process.env`.
    expect(t.env.SUBSTACK_PUBLICATION_URL).toBe("https://me.substack.com");
    expect(t.env.SUBSTACK_SESSION_TOKEN).toBe("tok-xyz");
    expect(t.env.SUBSTACK_USER_ID).toBe("98765");
    expect(typeof t.env.PATH).toBe("string");
    expect(typeof t.env.HOME).toBe("string");
    expect(Object.keys(t.env).sort()).toEqual([
      "HOME",
      "PATH",
      "SUBSTACK_PUBLICATION_URL",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
    ]);
  });

  test("Client.connect() and callTool() get the right wiring", async () => {
    await createPostType(storeKit, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "system",
    });
    seedSuccessfulFetchAndSummaryLlm(["sum-A"]);
    _setLlmForTests(makeComposeLlm("Composed body text.").llm);

    await generateSubstackDraft(
      {
        postTypeSlug: "weekly",
        urls: ["https://x.test/a"],
        titleOverride: "Custom Title",
        subtitleOverride: "Custom Sub",
      },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "tok-xyz",
            substack_user_id: "98765",
          },
        },
      },
    );

    // Client constructed with the extension's identifier; capabilities
    // is an empty object (we use no capabilities-handshake features yet).
    expect(capturedClientInit).not.toBeNull();
    expect(capturedClientInit!.name).toBe("ezcorp-substack-pilot");
    expect(capturedClientInit!.version).toBe("1.0.0");

    // connect() got the fake transport instance we constructed.
    expect(capturedConnectTransport).toBeInstanceOf(FakeStdioClientTransport);

    // callTool routed the composed args verbatim.
    expect(capturedCallToolReqs).toHaveLength(1);
    const req = capturedCallToolReqs[0]!;
    expect(req.name).toBe("create_draft_post");
    expect(req.arguments.title).toBe("Custom Title");
    expect(req.arguments.subtitle).toBe("Custom Sub");
    expect(req.arguments.body).toBe("Composed body text.");
  });
});

describe("dynamic SDK import — error mapping", () => {
  test("upstream isError:true maps to MCP_ERROR tool error with the upstream text", async () => {
    await createPostType(storeKit, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "system",
    });
    seedSuccessfulFetchAndSummaryLlm(["sum-A"]);
    _setLlmForTests(makeComposeLlm("body").llm);
    isErrorMode = true;

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "tok-xyz",
            substack_user_id: "98765",
          },
        },
      },
    );
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("MCP_ERROR");
    expect(getText(res)).toContain("401 from substack");
  });
});

describe("dynamic SDK import — caller singleton", () => {
  test("production caller is constructed exactly once across multiple calls", async () => {
    // The production caller is cached via `_productionCallerPromise` so
    // the SDK Client + transport are spawned once per subprocess lifetime.
    // Two back-to-back calls must NOT result in two transport
    // constructions.
    await createPostType(storeKit, {
      slug: "weekly",
      name: "Weekly",
      systemPrompt: "system",
    });
    seedSuccessfulFetchAndSummaryLlm(["a", "b"]);
    _setLlmForTests(makeComposeLlm("body").llm);

    const meta = {
      invocationMetadata: {
        settings: {
          substack_publication_url: "https://me.substack.com",
          substack_session_token: "tok-xyz",
          substack_user_id: "98765",
        },
      },
    };
    await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      meta,
    );
    const firstTransport = capturedTransport;
    expect(firstTransport).not.toBeNull();
    // Reset summarize so the second call doesn't trip on a drained answers list.
    seedSuccessfulFetchAndSummaryLlm(["c"]);
    await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/b"] },
      meta,
    );
    // Identity check: the transport captured by the second invocation is
    // the same object reference as the first (i.e. no second construction).
    expect(capturedTransport).toBe(firstTransport);
    expect(capturedCallToolReqs).toHaveLength(2);
  });
});
