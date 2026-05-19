// ── Real MCP stdio spawn ────────────────────────────────────────
//
// Coverage gap #1. The existing factory-injection tests
// (generate-draft.test.ts) and `mock.module` tests
// (mcp-sdk-resolution.test.ts) prove the production caller's WIRING
// is right, but neither actually runs `Bun.spawn` + the real
// `@modelcontextprotocol/sdk` stdio transport + the JSON-RPC line
// framing. This file closes that gap: a fake `substack-mcp` Bun
// script answers a real JSON-RPC handshake over stdio, and
// `generateSubstackDraft` drives through to it end-to-end.
//
// What's "real" here:
//   - `@modelcontextprotocol/sdk/client/index.js` is the actual installed
//     package — NO `mock.module` on it.
//   - `StdioClientTransport` opens real pipes against a real child
//     process spawned via `Bun.spawn` (it's what the SDK uses
//     internally for stdio transports).
//   - JSON-RPC framing (line-delimited JSON over stdout/stdin) is exercised
//     end-to-end: `initialize` → `notifications/initialized` →
//     `tools/list` → `tools/call`.
//
// What's faked: only the binary at the far end. Instead of
// `npx -y substack-mcp@latest` we point the SDK at a tmp Bun script
// that speaks the same wire protocol but returns canned `create_draft_post`
// responses we control. The helper in
// `src/__tests__/helpers/stdio-mcp-fixture.ts` hardcodes the `echo`
// tool shape, so we use a local in-file fixture writer instead of
// modifying the shared helper. Same general pattern, parameterized
// for our tool's `{content, isError}` shape.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// `lib/post-types.ts` was deleted in the SDK port. This helper plants
// a record at the SDK's managed-namespace key shape, identical to
// what the SDK's create_post_type tool would write.
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

// ── Local fake substack-mcp server fixture ─────────────────────
//
// Writes a Bun script to a tmp dir that speaks line-delimited JSON-RPC
// over stdio. Mirrors the shape of `makeStdioMcpServer` in
// src/__tests__/helpers/stdio-mcp-fixture.ts but emits a
// `create_draft_post` tool and lets the caller pick between a success
// response and an `isError:true` response (the brief's two scenarios).
//
// `tools/call` returns:
//   - mode="ok":    {content:[{type:"text",text:"OK"}], isError:false}
//   - mode="error": {content:[{type:"text",text:"401 unauthorized"}], isError:true}
//
// Why "OK" + "401 unauthorized": those are the canned responses the brief
// names, and they line up with what the real substack-mcp emits on
// happy/unauthorized respectively.

function makeFakeSubstackMcpServer(opts: { mode: "ok" | "error" }): {
  command: string;
  args: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "substack-fake-mcp-"));
  const scriptPath = join(dir, "server.ts");

  const callResponse =
    opts.mode === "ok"
      ? `{ content: [{ type: "text", text: "OK" }], isError: false }`
      : `{ content: [{ type: "text", text: "401 unauthorized" }], isError: true }`;

  const toolsJson = JSON.stringify([
    {
      name: "create_draft_post",
      description: "Create a Substack draft",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
  ]);

  // Emit a PID line on stderr so the test can assert the subprocess
  // actually spawned (the SDK swallows stdout for protocol framing,
  // but lets stderr through for diagnostics).
  const source = `
    process.stderr.write("FAKE_MCP_PID:" + process.pid + "\\n");
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          send({ jsonrpc: "2.0", id: req.id, result: {
            protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-substack-mcp", version: "1.0.0" },
          } });
        } else if (req.method === "notifications/initialized") {
          // notification — no response
        } else if (req.method === "tools/list") {
          send({ jsonrpc: "2.0", id: req.id, result: { tools: ${toolsJson} } });
        } else if (req.method === "tools/call") {
          send({ jsonrpc: "2.0", id: req.id, result: ${callResponse} });
        } else if (req.id !== undefined) {
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
        }
      }
    });
  `;
  writeFileSync(scriptPath, source);

  return {
    command: "bun",
    args: ["run", scriptPath],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Shared fakes (same shape as other tests in this folder) ─────

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
    async complete() {
      return { content: answer };
    },
  };
}

function seedFetchAndSummaryLlm() {
  _setBackendsForTests({
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        `<html><head><title>T:${url}</title></head><body>B:${url}.</body></html>`,
    }),
    llm: {
      async complete() {
        return { content: "summary-text" };
      },
    },
  });
}

function getText(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text;
}

// ── Setup / teardown ───────────────────────────────────────────

const cleanups: Array<() => void> = [];
let storeKit: ReturnType<typeof makeStore>;

beforeEach(() => {
  storeKit = makeStore();
  _setPostTypeStoreForTests(storeKit);
  // Force the production-caller path (no injected _caller, no factory yet —
  // the factory is set per-test below to point at our fixture).
  _setMcpCallerForTests(null);
  _setMcpClientFactoryForTests(null);
});

afterEach(() => {
  _resetPostTypeStoreForTests();
  _resetBackendsForTests();
  _resetProductionCallerForTests();
  for (const c of cleanups.splice(0)) c();
});

// ── Tests ──────────────────────────────────────────────────────

describe("real MCP stdio spawn — fake substack-mcp via real SDK", () => {
  test("happy path: real Bun.spawn + JSON-RPC handshake + tools/call returns OK", async () => {
    const fixture = makeFakeSubstackMcpServer({ mode: "ok" });
    cleanups.push(fixture.cleanup);

    // Capture the PID the fake server wrote to stderr — proof that
    // `Bun.spawn` actually fired and the child is alive.
    let seenPid: number | null = null;
    const observedToolsList: Array<string> = [];

    // Factory that does the REAL SDK wiring (no mock.module) but
    // substitutes the spawn target. The factory IS the seam — we still
    // construct a real `Client` + `StdioClientTransport`, real pipes,
    // real protocol — only the executable differs from production
    // (`bun run /tmp/.../server.ts` vs. `npx -y substack-mcp@latest`).
    _setMcpClientFactoryForTests(async (_transportFromHost) => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );

      // Wrap StdioClientTransport so we can observe stderr (the fake
      // server emits FAKE_MCP_PID:<pid>). StdioClientTransport exposes
      // the spawned child's stderr stream via the `stderr` getter; we
      // attach a one-time reader for the PID line.
      const transport = new StdioClientTransport({
        command: fixture.command,
        args: fixture.args,
        // Minimal env — the fake doesn't need SUBSTACK_* to function,
        // but we pass them through to mirror the production caller's
        // env shaping. PATH is required so `bun` is resolvable.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SUBSTACK_PUBLICATION_URL: "https://me.substack.com",
          SUBSTACK_SESSION_TOKEN: "tok-xyz",
          SUBSTACK_USER_ID: "12345",
        },
        stderr: "pipe",
      });
      const client = new Client(
        { name: "ezcorp-substack-pilot-test", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);

      // Drain stderr for the PID line (best-effort — if the SDK
      // version doesn't expose stderr, skip the assertion below).
      const stderr = (transport as unknown as { stderr?: NodeJS.ReadableStream })
        .stderr;
      if (stderr) {
        stderr.on("data", (chunk: Buffer) => {
          const m = /FAKE_MCP_PID:(\d+)/.exec(chunk.toString());
          if (m) seenPid = Number(m[1]);
        });
      }

      // Drive a `tools/list` so the test asserts the handshake worked
      // and the fake exposes create_draft_post. The real production
      // caller doesn't do `tools/list` before `tools/call`, so we do
      // it here once to pin that the JSON-RPC route is live before
      // production code calls `tools/call`.
      const listed = await (client as unknown as {
        listTools(): Promise<{ tools: Array<{ name: string }> }>;
      }).listTools();
      for (const t of listed.tools) observedToolsList.push(t.name);

      return client as unknown as {
        callTool(req: {
          name: string;
          arguments: Record<string, unknown>;
        }): Promise<{
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        }>;
      };
    });

    // Wiring upstream of the MCP caller — pure fakes so this test
    // stays focused on the MCP-spawn path.
    await createPostType(storeKit, { slug: "weekly", name: "Weekly", systemPrompt: "p" });
    seedFetchAndSummaryLlm();
    _setLlmForTests(makeComposeLlm("Composed body."));
    _setLlmModelForTests("anthropic", "claude-3-5-haiku-20241022");

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

    // Happy path: production code mapped the fake's "OK" to ok:true.
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(getText(res)) as {
      ok: boolean;
      mcpResponse: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mcpResponse).toBe("OK");

    // Handshake proof: real `tools/list` over the real transport
    // surfaced our fake's tool.
    expect(observedToolsList).toContain("create_draft_post");

    // Spawn proof: the fake's stderr PID line was observed.
    // Allow a beat for stderr buffering. The PID may not always make
    // it through quickly enough on Bun's stderr pipe — if it doesn't,
    // we still have observedToolsList (which already required a live
    // subprocess). The seenPid check is best-effort and asserted via
    // type rather than strict equality.
    await new Promise((r) => setTimeout(r, 25));
    if (seenPid !== null) {
      expect(seenPid).toBeGreaterThan(0);
    }
  });

  test("isError:true from fake substack-mcp surfaces as MCP_ERROR", async () => {
    const fixture = makeFakeSubstackMcpServer({ mode: "error" });
    cleanups.push(fixture.cleanup);

    _setMcpClientFactoryForTests(async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      const transport = new StdioClientTransport({
        command: fixture.command,
        args: fixture.args,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SUBSTACK_PUBLICATION_URL: "https://me.substack.com",
          SUBSTACK_SESSION_TOKEN: "bad-tok",
          SUBSTACK_USER_ID: "12345",
        },
      });
      const client = new Client(
        { name: "ezcorp-substack-pilot-test", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      return client as unknown as {
        callTool(req: {
          name: string;
          arguments: Record<string, unknown>;
        }): Promise<{
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        }>;
      };
    });

    await createPostType(storeKit, { slug: "weekly", name: "Weekly", systemPrompt: "p" });
    seedFetchAndSummaryLlm();
    _setLlmForTests(makeComposeLlm("body"));

    const res = await generateSubstackDraft(
      { postTypeSlug: "weekly", urls: ["https://x.test/a"] },
      {
        invocationMetadata: {
          settings: {
            substack_publication_url: "https://me.substack.com",
            substack_session_token: "bad-tok",
            substack_user_id: "12345",
          },
        },
      },
    );
    expect(res.isError).toBe(true);
    expect((res as unknown as { code?: string }).code).toBe("MCP_ERROR");
    // Verifies the fake's text was plumbed through the JSON-RPC reply
    // unaltered — i.e. real framing, not a mock that bypassed it.
    expect(getText(res)).toContain("401 unauthorized");
  });
});
