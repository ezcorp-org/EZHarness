/**
 * Integration coverage for `substack-pipeline`. Two layers the unit
 * suite (seamed invoke/llm/store) cannot reach:
 *
 *  (a) REGRESSION-PIN — proves the host limitation that forced the
 *      LLM-orchestrated design. A cross-extension `ezcorp/invoke` of
 *      `ask-user__ask_user_question` routed through the REAL
 *      `ToolExecutor.handlePiInvoke` → REAL `executeToolCall` → REAL
 *      `ask-user` subprocess returns `"missing tool-call context"`,
 *      because `handlePiInvoke` does not thread
 *      `invocationMetadata.{toolCallId,conversationId}` on the invoke
 *      path (tool-executor.ts:1180 / :780; ask-user/index.ts:168).
 *      If a future host change threads that metadata, THIS TEST FLIPS
 *      (the result stops being an error) — a signal that the design can
 *      be simplified back to a single in-extension tool.
 *
 *  (b) REAL SUBPROCESS WIRING — spawns the real `substack-pipeline`
 *      subprocess and acts as the host over stdio, answering its
 *      reverse RPCs (`ezcorp/invoke` for the non-requiresUserInput
 *      summarizer, `ezcorp/llm-complete` for WRITER, `ezcorp/storage`
 *      for scratch). Proves the extension's own channel wiring
 *      (index.ts dispatcher + lib/pipeline + invoke-helpers + scratch
 *      over the real @ezcorp/sdk runtime) — the part unit seams stub.
 *
 * No DB: `recordToolCall` routes through `persistToolCall`, which
 * swallows DB errors (tool-executor.ts:1820). Permission decisions use
 * the allow-all stub (cross-extension.test.ts pattern).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { JsonRpcRequest } from "../extensions/types";

const ROOT = join(import.meta.dir ?? process.cwd(), "..", "..");
const ASK_USER_ENTRY = join(
  ROOT, "docs", "extensions", "examples", "ask-user", "index.ts",
);
const PIPELINE_ENTRY = join(
  ROOT, "docs", "extensions", "examples", "substack-pipeline", "index.ts",
);

// ── stdio subprocess harness (ask-user.integration.test.ts pattern) ──

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExt(entry: string): TestProc {
  const proc = spawn(["bun", "run", entry], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, EZCORP_NETWORK_ALLOWED: "0", EZCORP_SHELL_ALLOWED: "0" },
  }) as Subprocess<"pipe", "pipe", "pipe">;

  const outbound: Record<string, unknown>[] = [];
  let buffer = "";
  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            outbound.push(JSON.parse(line));
          } catch {
            /* skip non-JSON noise */
          }
        }
      }
    } catch {
      /* closed */
    }
  })();
  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      /* */
    }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
  }
  async function wait(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 8000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = outbound.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("wait: predicate never satisfied");
  }
  function kill(): void {
    try {
      proc.kill();
    } catch {
      /* */
    }
  }
  return { proc, outbound, inbound, wait, kill };
}

// ── (a) Regression-pin: real handlePiInvoke → real ask-user ─────────

describe("substack-pipeline integration (a) — cross-ext ask-user is NOT viable", () => {
  let askProc: TestProc | null = null;

  beforeEach(() => {
    askProc = spawnExt(ASK_USER_ENTRY);
  });
  afterEach(() => {
    askProc?.kill();
    askProc = null;
  });

  test("handlePiInvoke('ask-user__ask_user_question') → 'missing tool-call context'", async () => {
    const ASK_EXT = "ext-ask-user-int";
    const askTool = {
      name: "ask-user__ask_user_question",
      originalName: "ask_user_question",
      description: "ask",
      inputSchema: { type: "object" },
      extensionId: ASK_EXT,
      extensionName: "ask-user",
    };
    const manifest = {
      schemaVersion: 2,
      name: "ask-user",
      version: "1.0.0",
      description: "ask-user",
      author: { name: "t" },
      permissions: {},
    };

    let nextId = 7_000_000;
    const procWrapper = {
      isRunning: true,
      setNotificationHandler: () => {},
      setRequestHandler: () => {},
      async callTool(
        name: string,
        args: Record<string, unknown>,
        meta?: Record<string, unknown>,
      ) {
        const id = ++nextId;
        askProc!.inbound({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args, ...(meta !== undefined ? { _meta: meta } : {}) },
        });
        const resp = await askProc!.wait(
          (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
        );
        return resp.error
          ? { content: [{ type: "text", text: JSON.stringify(resp.error) }], isError: true }
          : (resp.result as { content: Array<{ text: string }>; isError?: boolean });
      },
    };

    const fakeRegistry = {
      resolveDepTool: (_callerId: string, tool: string) =>
        tool === "ask-user__ask_user_question" ? askTool : null,
      getRegisteredTool: (n: string) =>
        n === "ask-user__ask_user_question" ? askTool : undefined,
      getManifest: () => manifest,
      getGrantedPermissions: () => ({ grantedAt: {} }),
      getInstallPath: () => "/tmp/ask-user-int",
      getMcpClient: () => {
        throw new Error("not MCP");
      },
      getProcess: async () => procWrapper,
    };

    const executor = new ToolExecutor(
      fakeRegistry as never,
      createStubPermissionEngine(),
    );

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: {
        tool: "ask-user__ask_user_question",
        arguments: { question: "Approve?", options: ["Approve", "Request changes"] },
      },
    };

    const response = await executor.handlePiInvoke("ext-substack-pipeline", req);

    // The host returns a tool RESULT (not a JSON-RPC error); the failure
    // is in-band — exactly the contract that makes the in-extension
    // ask-user loop impossible and forces the LLM-orchestrated design.
    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/missing tool-call context/i);
  });
});

// ── (b) Real substack-pipeline subprocess wiring ────────────────────

describe("substack-pipeline integration (b) — real subprocess channel wiring", () => {
  let pipe: TestProc | null = null;

  beforeEach(() => {
    pipe = spawnExt(PIPELINE_ENTRY);
  });
  afterEach(() => {
    pipe?.kill();
    pipe = null;
  });

  test("draft_substack_post round-trips summarize(invoke) + WRITER(llm) + scratch(storage)", async () => {
    const seen: string[] = [];
    // Host responder: answer the subprocess's reverse RPCs as they arrive.
    let i = 0;
    const pump = setInterval(() => {
      for (; i < pipe!.outbound.length; i++) {
        const m = pipe!.outbound[i]!;
        if (typeof m.method !== "string" || m.id === undefined) continue;
        if (m.method === "ezcorp/invoke") {
          const tool = (m.params as { tool?: string })?.tool ?? "";
          seen.push(`invoke:${tool}`);
          pipe!.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summaries: [{ url: "u", title: "Source Title", summary: "A factual summary." }],
                  }),
                },
              ],
              isError: false,
            },
          });
        } else if (m.method === "ezcorp/llm-complete") {
          seen.push("llm");
          pipe!.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              content: "# Generated Post\n\nReal-channel body.",
              blocks: [],
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "stop",
              model: "test",
            },
          });
        } else if (m.method === "ezcorp/storage") {
          seen.push(`storage:${(m.params as { action?: string })?.action}`);
          pipe!.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: { ok: true, sizeBytes: 42 },
          });
        }
      }
    }, 10);

    try {
      pipe!.inbound({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "draft_substack_post",
          arguments: { url: "https://example.com/post" },
        },
      });
      const resp = await pipe!.wait(
        (m) => m.id === 2 && (m.result !== undefined || m.error !== undefined),
        10000,
      );
      const result = resp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain("# Generated Post");
      expect(result.content[0]!.text).toContain("ask_user_question");
      // Proves the real wiring exercised all three reverse-RPC channels.
      expect(seen).toContain("invoke:substack-pilot__summarize_urls");
      expect(seen).toContain("llm");
      expect(seen).toContain("storage:set");
    } finally {
      clearInterval(pump);
    }
  });
});
